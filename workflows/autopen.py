import io
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from pypdf import PdfReader, PdfWriter
from docx import Document


class AutoPen:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.signatures_dir = self.data_dir / 'signatures'
        self.signed_dir = self.data_dir / 'signed'
        self.signatures_dir.mkdir(parents=True, exist_ok=True)
        self.signed_dir.mkdir(parents=True, exist_ok=True)

    # ── Signature management ─────────────────────────────────────────

    def save_signature(self, signature_data_url: str) -> str:
        """Persist a signature from a data URL (base64 PNG from canvas)."""
        _header, data = signature_data_url.split(',', 1)
        img_data = base64.b64decode(data)
        sig_path = self.signatures_dir / 'signature.png'
        with open(sig_path, 'wb') as f:
            f.write(img_data)
        return str(sig_path)

    def has_signature(self) -> bool:
        return (self.signatures_dir / 'signature.png').exists()

    def get_signature_data_url(self) -> str | None:
        sig_path = self.signatures_dir / 'signature.png'
        if not sig_path.exists():
            return None
        with open(sig_path, 'rb') as f:
            data = f.read()
        return 'data:image/png;base64,' + base64.b64encode(data).decode()

    def clear_signature(self):
        sig_path = self.signatures_dir / 'signature.png'
        if sig_path.exists():
            sig_path.unlink()

    # ── DOCX → PDF conversion ────────────────────────────────────────

    @staticmethod
    def _find_libreoffice() -> str | None:
        """Return path to LibreOffice/soffice binary, or None if not installed."""
        for name in ('soffice', 'libreoffice'):
            path = shutil.which(name)
            if path:
                return path
        # Common macOS install location
        mac_path = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
        if os.path.exists(mac_path):
            return mac_path
        return None

    def docx_to_pdf_bytes(self, docx_path: str) -> bytes:
        """
        Convert a DOCX file to PDF bytes, preserving formatting.

        Strategy (in order):
          1. LibreOffice headless — pixel-perfect conversion, installed in Docker
          2. python-docx + reportlab — text-only fallback when LibreOffice is absent
        """
        soffice = self._find_libreoffice()
        if soffice:
            return self._convert_with_libreoffice(soffice, docx_path)
        return self._convert_with_reportlab(docx_path)

    def _convert_with_libreoffice(self, soffice: str, docx_path: str) -> bytes:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = subprocess.run(
                [
                    soffice,
                    '--headless',
                    '--norestore',
                    '--nofirststartwizard',
                    '--convert-to', 'pdf',
                    '--outdir', tmpdir,
                    docx_path,
                ],
                capture_output=True,
                timeout=120,
                env={**os.environ, 'HOME': tmpdir},  # avoid profile lock conflicts
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f'LibreOffice conversion failed: {result.stderr.decode(errors="replace")}'
                )
            pdf_path = Path(tmpdir) / (Path(docx_path).stem + '.pdf')
            if not pdf_path.exists():
                raise RuntimeError('LibreOffice did not produce a PDF file.')
            return pdf_path.read_bytes()

    def _convert_with_reportlab(self, docx_path: str) -> bytes:
        """Text-only fallback — used only when LibreOffice is unavailable."""
        doc = Document(docx_path)
        buf = io.BytesIO()

        styles = getSampleStyleSheet()
        normal = ParagraphStyle('body', parent=styles['Normal'],
                                fontSize=11, leading=15, spaceAfter=6)
        h1 = ParagraphStyle('h1', parent=styles['Heading1'],
                             fontSize=16, leading=20, spaceBefore=12, spaceAfter=6)
        h2 = ParagraphStyle('h2', parent=styles['Heading2'],
                             fontSize=13, leading=17, spaceBefore=10, spaceAfter=4)
        heading_map = {'Heading 1': h1, 'Heading 2': h2, 'Heading 3': h2, 'Title': h1}

        pdf_doc = SimpleDocTemplate(buf, pagesize=letter,
                                    leftMargin=inch, rightMargin=inch,
                                    topMargin=inch, bottomMargin=inch)
        story = []
        for para in doc.paragraphs:
            text = para.text
            if not text.strip():
                story.append(Spacer(1, 6))
                continue
            style = heading_map.get(para.style.name if para.style else '', normal)
            safe = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            story.append(Paragraph(safe, style))

        if not story:
            story.append(Paragraph('(empty document)', normal))
        pdf_doc.build(story)
        return buf.getvalue()

    # ── Signature field detection ────────────────────────────────────

    # Matches chair/director label text in field names and page content
    _CHAIR_RE = re.compile(
        r'(chair(?:person)?|department\s+chair|project\s+director'
        r'|student[\'s]*\s+program\s+director|program\s+director)',
        re.IGNORECASE,
    )
    _SIG_RE = re.compile(r'\bsignature\b', re.IGNORECASE)

    def find_signature_field_placement(self, pdf_bytes: bytes) -> list | None:
        """
        Auto-detect the chair/director signature field in a PDF.
        Returns a one-item placement list or None if nothing found.

        Strategy 1: AcroForm widget — empty /FT field near a chair/sig label.
        Strategy 1b: AcroForm widget — field whose /T or /TU name matches chair pattern.
        Strategy 2: Text-label proximity scan (flat PDFs with no form fields).
        """
        reader = PdfReader(io.BytesIO(pdf_bytes))
        # Pass 0: Observation of Teaching — two specific label patterns
        obs = self._find_observation_form_placements(reader)
        if obs:
            return obs
        placement = self._find_acroform_field(reader)
        if placement:
            return [placement]
        placement = self._find_by_text_label(reader)
        if placement:
            return [placement]
        return None

    @staticmethod
    def _get_page_annots(page) -> list:
        """Return the annotation list for a page, resolving indirect objects."""
        annots = page.get('/Annots')
        if annots is None:
            return []
        try:
            annots = annots.get_object()
        except Exception:
            pass
        return annots if isinstance(annots, list) else []

    @staticmethod
    def _extract_text_positions(page) -> list[tuple[str, float, float]]:
        """Return [(text, x, y), ...] for all non-empty text pieces on a page."""
        parts: list[tuple[str, float, float]] = []

        def _vis(text, _cm, tm, _fd, _fs):
            t = (text or '').strip()
            if t and tm:
                parts.append((t, float(tm[4]), float(tm[5])))

        try:
            page.extract_text(visitor_text=_vis)
        except Exception:
            pass
        return parts

    def _find_acroform_field(self, reader) -> dict | None:
        """
        Three-pass AcroForm scan:
          Pass A — empty /FT field closest to a chair/sig label (text-scored).
          Pass B — field whose /T or /TU name directly matches the chair pattern.
          Pass C — bottom-most empty /FT field on the last page (scanned PDFs with
                   no text layer; chair always signs last).
        """
        # Pass A: score each empty-/FT field by distance to nearest chair/sig label
        candidates: list[tuple[float, int, dict]] = []  # (score, page, placement)
        all_empty_ft: list[tuple[int, float, float, dict]] = []  # (page, x1, y1, placement)

        for page_num, page in enumerate(reader.pages):
            page_w = float(page.mediabox.width)
            page_h = float(page.mediabox.height)
            text_pos = self._extract_text_positions(page)

            for ref in self._get_page_annots(page):
                try:
                    a = ref.get_object()
                except Exception:
                    continue
                ft = str(a.get('/FT', 'TYPED'))
                if ft not in ('', 'TYPED'):  # skip /Tx, /Btn, etc.
                    continue
                rect = a.get('/Rect')
                if not rect:
                    continue
                x1, y1, x2, y2 = (float(v) for v in rect)
                field_cx = (x1 + x2) / 2
                field_cy = (y1 + y2) / 2
                placement = {
                    'page':   page_num,
                    'x':      x1 / page_w,
                    'y':      y1 / page_h,
                    'width':  max((x2 - x1) / page_w, 0.20),
                    'height': max((y2 - y1) / page_h, 0.03),
                }
                all_empty_ft.append((page_num, x1, y1, placement))

                best = float('inf')
                for txt, tx, ty in text_pos:
                    if self._CHAIR_RE.search(txt) or self._SIG_RE.search(txt):
                        # Penalise fields that sit well above the label — the chair
                        # signature box is always at or below its label in reading order.
                        above_penalty = 50 if field_cy > ty + 50 else 0
                        dist = abs(ty - field_cy) + abs(tx - field_cx) * 0.3 + above_penalty
                        if dist < best:
                            best = dist

                if best < 200:  # within ~2.8 inches
                    candidates.append((best, page_num, placement))

        if candidates:
            candidates.sort(key=lambda c: c[0])
            return candidates[0][2]

        # Pass B: field name / tooltip matches chair pattern
        for page_num, page in enumerate(reader.pages):
            page_w = float(page.mediabox.width)
            page_h = float(page.mediabox.height)
            for ref in self._get_page_annots(page):
                try:
                    a = ref.get_object()
                except Exception:
                    continue
                t  = str(a.get('/T', ''))
                tu = str(a.get('/TU', ''))
                if not (self._CHAIR_RE.search(t) or self._CHAIR_RE.search(tu)):
                    continue
                rect = a.get('/Rect')
                if not rect:
                    continue
                x1, y1, x2, y2 = (float(v) for v in rect)
                return {
                    'page':   page_num,
                    'x':      x1 / page_w,
                    'y':      y1 / page_h,
                    'width':  max((x2 - x1) / page_w, 0.20),
                    'height': max((y2 - y1) / page_h, 0.03),
                }

        # Pass C: scanned PDF — bottom-most empty-/FT field on the last page
        # (chair signs last; lowest y = lowest on the page in PDF coordinates)
        if all_empty_ft:
            last_page = max(p for p, *_ in all_empty_ft)
            on_last = [(x1, y1, pl) for p, x1, y1, pl in all_empty_ft if p == last_page]
            # Sort: bottom-most (lowest y1) first, then left-most among ties
            on_last.sort(key=lambda t: (t[1], t[0]))
            return on_last[0][2]

        return None

    _APPROVAL_RE = re.compile(r'\bapproval\b', re.IGNORECASE)

    _CHAIRPERSON_SIG_RE = re.compile(
        r"chairperson.{0,3}signature",   # handles straight/curly apostrophe variants
        re.IGNORECASE,
    )
    _PB_RE = re.compile(
        r"department\s+p\s*&\s*b|p\s*&\s*b\s+member|assigned\s+by\s+.*chairperson",
        re.IGNORECASE,
    )

    def _find_observation_form_placements(self, reader) -> list[dict] | None:
        """
        Detect Peer Observation of Teaching signature spots.
        Returns placements above 'Chairperson's Signature' and (if present)
        'Department P&B Member or other assigned by Chairperson' labels.
        Returns None if neither label is found.

        The signature line in DOCX-converted PDFs sits just above its label;
        we place the sig box 15 pts above the label baseline.
        """
        SIG_H_PT       = 25.0
        SIG_W_FRAC     = 0.38
        ABOVE_OFFSET   = 15.0   # pts above label baseline → matches where author signed

        placements: list[dict] = []
        for page_num, page in enumerate(reader.pages):
            page_w = float(page.mediabox.width)
            page_h = float(page.mediabox.height)
            text_pos = self._extract_text_positions(page)
            for txt, tx, ty in text_pos:
                if self._CHAIRPERSON_SIG_RE.search(txt):
                    placements.append({
                        'page':   page_num,
                        'x':      tx / page_w,
                        'y':      (ty + ABOVE_OFFSET) / page_h,
                        'width':  SIG_W_FRAC,
                        'height': SIG_H_PT / page_h,
                    })
                elif self._PB_RE.search(txt):
                    placements.append({
                        'page':   page_num,
                        'x':      tx / page_w,
                        'y':      (ty + ABOVE_OFFSET) / page_h,
                        'width':  SIG_W_FRAC,
                        'height': SIG_H_PT / page_h,
                    })
        return placements if placements else None

    def _find_by_text_label(self, reader) -> dict | None:
        """
        For flat PDFs with no AcroForm fields.

        Pass 1: find a chair heading that has a standalone 'Signature' line below it
                (within 120 pts); place the image to the right of that line.
        Pass 2: no Signature sibling — prefer 'approval' section headers, else
                the bottom-most chair label; place on the right side of the page.
        """
        SIG_W_FRAC = 0.30
        SIG_H_PT   = 25.0

        for page_num, page in enumerate(reader.pages):
            page_w = float(page.mediabox.width)
            page_h = float(page.mediabox.height)
            text_pos = self._extract_text_positions(page)

            chair_labels = [
                (ty, tx, txt) for txt, tx, ty in text_pos
                if self._CHAIR_RE.search(txt)
            ]
            # debug: print("CHAIR_LABELS", chair_labels)
            if not chair_labels:
                continue

            # Pass 1: chair label with a standalone "Signature" line below it
            for chair_y, _cx, _ct in sorted(chair_labels, reverse=True):
                sig_cands = [
                    (tx, ty) for txt, tx, ty in text_pos
                    if self._SIG_RE.search(txt)
                    and not self._CHAIR_RE.search(txt)
                    and (chair_y - 120) <= ty <= chair_y
                ]
                if not sig_cands:
                    continue
                sig_x, sig_y = max(sig_cands, key=lambda p: p[0])
                sig_start_x = sig_x + page_w * 0.05
                if sig_start_x + page_w * SIG_W_FRAC > page_w * 0.95:
                    sig_start_x = page_w * 0.40
                return {
                    'page':   page_num,
                    'x':      sig_start_x / page_w,
                    'y':      max(0.01, (sig_y - SIG_H_PT * 0.5) / page_h),
                    'width':  SIG_W_FRAC,
                    'height': SIG_H_PT / page_h,
                }

            # Pass 2: no Signature sibling — pick the best chair label and place
            # to the right of it.  Prefer explicit "approval" headers; fall back to
            # bottom-most chair mention (chair signs last on the form).
            approval_labels = [t for t in chair_labels if self._APPROVAL_RE.search(t[2])]
            pool = approval_labels if approval_labels else chair_labels
            chair_y, _cx, _ct = sorted(pool)[0]  # bottom-most (lowest y)
            return {
                'page':   page_num,
                'x':      0.55,
                'y':      max(0.01, (chair_y - 10) / page_h),
                'width':  SIG_W_FRAC,
                'height': SIG_H_PT / page_h,
            }
        return None

    # ── PDF signing ──────────────────────────────────────────────────

    def _make_signature_overlay(self, sig_img: Image.Image, page_w: float,
                                 page_h: float, placements: list) -> bytes:
        """Return a one-page PDF overlay containing the signature at each placement."""
        packet = io.BytesIO()
        c = canvas.Canvas(packet, pagesize=(page_w, page_h))
        img_reader = ImageReader(sig_img)

        for p in placements:
            # x, y are fractions of page; y=0 is bottom (PDF coordinate origin)
            x = p.get('x', 0.6) * page_w
            y = p.get('y', 0.05) * page_h
            w = p.get('width', 0.28) * page_w
            h = p.get('height', 0.08) * page_h
            c.drawImage(img_reader, x, y, w, h, mask='auto')

        c.save()
        packet.seek(0)
        return packet.read()

    def sign_pdf_bytes(self, pdf_bytes: bytes, placements: list) -> bytes:
        """
        Overlay the stored signature onto specified pages of a PDF.

        placements: list of dicts with keys:
          page   – 0-based page index
          x      – left edge as fraction of page width  (0 = left)
          y      – bottom edge as fraction of page height (0 = bottom)
          width  – signature width as fraction of page width
          height – signature height as fraction of page height
        """
        sig_path = self.signatures_dir / 'signature.png'
        if not sig_path.exists():
            raise ValueError('No signature saved. Please set your signature first.')

        sig_img = Image.open(str(sig_path)).convert('RGBA')

        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter()

        # Group placements by page
        by_page: dict[int, list] = {}
        for p in placements:
            pg = int(p.get('page', 0))
            by_page.setdefault(pg, []).append(p)

        for i, page in enumerate(reader.pages):
            page_w = float(page.mediabox.width)
            page_h = float(page.mediabox.height)

            if i in by_page:
                overlay_bytes = self._make_signature_overlay(
                    sig_img, page_w, page_h, by_page[i]
                )
                overlay_reader = PdfReader(io.BytesIO(overlay_bytes))
                page.merge_page(overlay_reader.pages[0])

            writer.add_page(page)

        out = io.BytesIO()
        writer.write(out)
        return out.getvalue()

    # ── Text overlay helpers ─────────────────────────────────────────

    # Matches the _PP_TEXT_H constant in app.js — fraction of page height used
    # as the visual height of a text-field overlay in the placement picker.
    _TEXT_BOX_H_FRAC = 0.035

    def _make_text_overlay(self, page_w: float, page_h: float,
                           text_items: list) -> bytes:
        """Return a one-page PDF overlay with text drawn at each position.

        Each item in text_items must have:
            text           – string to draw
            x              – left edge as fraction of page width
            y              – BOTTOM of the text box as fraction of page height
                             (0 = page bottom, PDF convention)
            font_size      – point size (default 11)
            box_height_frac – fraction of page height used for the visual box
                             (default _TEXT_BOX_H_FRAC); used to centre text
        """
        packet = io.BytesIO()
        c = canvas.Canvas(packet, pagesize=(page_w, page_h))
        for item in text_items:
            text = str(item.get('text', '')).strip()
            if not text:
                continue
            x      = float(item.get('x', 0.1)) * page_w
            y_bot  = float(item.get('y', 0.1)) * page_h   # bottom of visual box
            fs     = float(item.get('font_size', 11))
            box_h  = float(item.get('box_height_frac',
                                    self._TEXT_BOX_H_FRAC)) * page_h
            # Vertically centre the text within the box.
            # ReportLab drawString places the BASELINE at y; cap-height ≈ 0.72*fs.
            # We want the cap-top near the visual box top and the baseline well
            # inside, so: baseline = box_bottom + (box_h - fs) / 2
            y = y_bot + max(0.0, (box_h - fs) / 2.0)
            c.setFont('Helvetica', fs)
            c.setFillColorRGB(0, 0, 0)
            c.drawString(x, y, text)
        c.save()
        packet.seek(0)
        return packet.read()

    def _apply_text_overlays(self, pdf_bytes: bytes,
                             text_by_page: dict) -> bytes:
        """Merge text overlays into a PDF in-place.

        text_by_page: {page_num: [text_item, ...]}
        Each text_item has the same shape as in _make_text_overlay.
        """
        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter()
        for i, page in enumerate(reader.pages):
            if i in text_by_page:
                page_w = float(page.mediabox.width)
                page_h = float(page.mediabox.height)
                overlay_bytes = self._make_text_overlay(
                    page_w, page_h, text_by_page[i]
                )
                overlay_reader = PdfReader(io.BytesIO(overlay_bytes))
                page.merge_page(overlay_reader.pages[0])
            writer.add_page(page)
        out = io.BytesIO()
        writer.write(out)
        return out.getvalue()

    # ── Public entry point ───────────────────────────────────────────

    def render_page_png(self, pdf_bytes: bytes, page_num: int, dpi: int = 120) -> bytes:
        """Render one page of a PDF to PNG bytes using PyMuPDF."""
        try:
            import fitz  # pymupdf
        except ImportError:
            raise RuntimeError("pymupdf not installed — rebuild the Docker image.")
        doc = fitz.open(stream=pdf_bytes, filetype='pdf')
        page = doc[page_num]
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        return pix.tobytes('png')

    def page_count(self, pdf_bytes: bytes) -> int:
        """Return number of pages in a PDF."""
        from pypdf import PdfReader
        import io
        return len(PdfReader(io.BytesIO(pdf_bytes)).pages)

    # ── Form type registry ────────────────────────────────────────────

    @property
    def _form_types_path(self) -> Path:
        return self.data_dir / 'form_types.json'

    def _load_form_types(self) -> dict:
        try:
            return json.loads(self._form_types_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_form_types_data(self, registry: dict) -> None:
        self._form_types_path.write_text(json.dumps(registry, indent=2))

    def list_form_types(self) -> list[dict]:
        registry = self._load_form_types()
        return [
            {
                'name':            name,
                'placement':       data['placement'],
                'name_placement':  data.get('name_placement'),
                'date_placement':  data.get('date_placement'),
                'text_placements': data.get('text_placements') or [],
                'created':         data.get('created', ''),
            }
            for name, data in sorted(registry.items())
        ]

    def get_form_type_placement(self, name: str) -> dict | None:
        registry = self._load_form_types()
        entry = registry.get(name)
        return entry['placement'] if entry else None

    def get_form_type_data(self, name: str) -> dict | None:
        """Return the full form-type entry including optional name/date placements."""
        registry = self._load_form_types()
        return registry.get(name)

    def match_form_type_for_file(self, filename: str,
                                  pdf_bytes: bytes | None = None) -> str | None:
        """Return the best-matching saved form type name for *filename*, or None.

        Matching strategy (first hit wins):
        1. Exact name match (case-insensitive, with or without extension).
        2. Fuzzy stem match via SequenceMatcher with threshold ≥ 0.75.
        3. If pdf_bytes is provided, extract PDF title/heading and fuzzy-match that.
        """
        from difflib import SequenceMatcher

        registry = self._load_form_types()
        if not registry:
            return None

        file_stem = Path(filename).stem.lower()

        # Pass 1: exact (case-insensitive)
        for ft_name in registry:
            ft_stem = Path(ft_name).stem.lower() if '.' in ft_name else ft_name.lower()
            if file_stem == ft_stem or file_stem == ft_name.lower():
                return ft_name

        # Pass 2: fuzzy stem match
        best_score, best_name = 0.0, None
        for ft_name in registry:
            ft_stem = Path(ft_name).stem.lower() if '.' in ft_name else ft_name.lower()
            score = SequenceMatcher(None, file_stem, ft_stem).ratio()
            if score > best_score:
                best_score, best_name = score, ft_name
        if best_score >= 0.75:
            return best_name

        # Pass 3: match against PDF title / suggested form name
        if pdf_bytes:
            try:
                suggested = self.suggest_form_name(pdf_bytes).lower()
                if suggested:
                    for ft_name in registry:
                        ft_key = ft_name.lower().replace('.pdf', '').replace('.docx', '')
                        score = SequenceMatcher(None, suggested, ft_key).ratio()
                        if score > best_score:
                            best_score, best_name = score, ft_name
                    if best_score >= 0.70:
                        return best_name
            except Exception:
                pass

        return None

    def save_form_type(self, name: str, placement: dict,
                       name_placement: dict | None = None,
                       date_placement: dict | None = None,
                       text_placements: list | None = None,
                       pdf_bytes: bytes | None = None) -> None:
        """Save a form type with optional anchor data computed from pdf_bytes."""
        registry = self._load_form_types()
        enhanced = dict(placement)
        if pdf_bytes:
            anchor = self._find_anchor_for_placement(pdf_bytes, placement)
            if anchor:
                enhanced['anchor'] = anchor
        registry[name] = {
            'placement':      enhanced,
            'name_placement': name_placement,
            'date_placement': date_placement,
            'text_placements': text_placements or [],
            'created':        datetime.now().strftime('%Y-%m-%d %H:%M'),
        }
        self._save_form_types_data(registry)

    def get_resolved_form_type_placement(self, name: str,
                                         pdf_bytes: bytes | None = None) -> list[dict] | None:
        """Return signature placements for a form type as a list, anchor-adjusted
        per occurrence when pdf_bytes is supplied and anchor data is stored.

        Returns a list of placement dicts (one per anchor occurrence found), or
        None if the form type doesn't exist.  Falls back to [stored] when anchor
        resolution is unavailable or the form layout has drifted too far.
        """
        ft = self._load_form_types().get(name)
        if not ft:
            return None
        stored = ft['placement']
        if pdf_bytes:
            adjusted = self._resolve_anchor_placement(pdf_bytes, stored)
            if adjusted is not None:
                return adjusted   # already a list
        return [stored]

    def delete_form_type(self, name: str) -> bool:
        registry = self._load_form_types()
        if name not in registry:
            return False
        del registry[name]
        self._save_form_types_data(registry)
        return True

    def rename_form_type(self, old_name: str, new_name: str,
                         placement: dict | None = None,
                         name_placement: dict | None = None,
                         date_placement: dict | None = None,
                         text_placements: list | None = None) -> bool:
        """Rename a form type and optionally update its placements.

        Returns True if found and updated, False if old_name not found.
        """
        registry = self._load_form_types()
        if old_name not in registry:
            return False
        entry = registry.pop(old_name)
        if placement is not None:
            entry['placement'] = placement
        if name_placement is not None:
            entry['name_placement'] = name_placement
        if date_placement is not None:
            entry['date_placement'] = date_placement
        if text_placements is not None:
            entry['text_placements'] = text_placements
        entry['updated'] = datetime.now().strftime('%Y-%m-%d %H:%M')
        registry[new_name] = entry
        self._save_form_types_data(registry)
        return True

    def suggest_form_name(self, pdf_bytes: bytes) -> str:
        """Extract a suggested form name from PDF metadata title or first-page heading."""
        reader = PdfReader(io.BytesIO(pdf_bytes))
        # Try /Title metadata
        try:
            meta = reader.metadata
            if meta:
                title = str(meta.get('/Title') or '').strip()
                if title and len(title) > 2:
                    return title[:80]
        except Exception:
            pass
        # Fall back to first substantial text line on page 1
        if reader.pages:
            parts: list[tuple[str, float, float]] = []
            def _vis(text, _cm, tm, _fd, _fs):
                t = (text or '').strip()
                if t and tm:
                    parts.append((t, float(tm[4]), float(tm[5])))
            try:
                reader.pages[0].extract_text(visitor_text=_vis)
            except Exception:
                pass
            parts.sort(key=lambda p: -p[2])   # top of page first (highest y)
            for text, _, _ in parts:
                if len(text) > 5 and not re.match(r'^[\d\s/\-\.\,]+$', text):
                    return text[:80]
        return ''

    # ── Anchor-relative placement ────────────────────────────────────

    def _find_anchor_for_placement(self, pdf_bytes: bytes,
                                   placement: dict) -> dict | None:
        """
        Find the text line immediately above a signature placement and return
        anchor data that can later be used to re-locate the sig box even if
        the form layout has shifted.

        Strategy: among all text fragments on the same page that sit ABOVE the
        sig box (higher y in PDF coordinates) and within 1.5 inches, pick the
        one closest to the top of the sig box.  Skip very short fragments that
        are likely line artefacts.

        Returns a dict with:
            anchor_text_norm  – normalised anchor string for fuzzy matching
            anchor_page       – 0-based page index
            anchor_y_frac     – anchor y as fraction of page height (from bottom)
            anchor_x_frac     – anchor x as fraction of page width
            sig_dy            – (sig_y_frac − anchor_y_frac), usually negative
            sig_dx            – (sig_x_frac − anchor_x_frac)
        or None if no suitable anchor is found.
        """
        reader = PdfReader(io.BytesIO(pdf_bytes))
        page_num = int(placement.get('page', 0))
        if page_num >= len(reader.pages):
            return None

        page   = reader.pages[page_num]
        page_w = float(page.mediabox.width)
        page_h = float(page.mediabox.height)

        sig_y = placement.get('y', 0) * page_h   # bottom of sig box, pts from bottom
        sig_x = placement.get('x', 0) * page_w
        sig_top = sig_y + placement.get('height', 0.08) * page_h

        text_pos = self._extract_text_positions(page)   # [(text, x, y), ...]

        INCH = 72.0  # 1 inch in PDF points
        candidates = [
            (txt, tx, ty)
            for txt, tx, ty in text_pos
            if ty > sig_top                   # strictly above the sig box
            and ty < sig_top + 1.5 * INCH    # within 1.5 inches
            and len(txt.strip()) >= 4         # skip artefact fragments
        ]
        if not candidates:
            return None

        # Closest fragment above the sig box (smallest positive gap)
        anchor_txt, anchor_x, anchor_y = min(
            candidates, key=lambda t: t[2] - sig_top
        )
        norm = re.sub(r'\s+', ' ', anchor_txt.strip().lower())
        return {
            'anchor_text_norm': norm,
            'anchor_page':      page_num,
            'anchor_y_frac':    anchor_y / page_h,
            'anchor_x_frac':    anchor_x / page_w,
            'sig_dy':           (sig_y    - anchor_y) / page_h,
            'sig_dx':           (sig_x    - anchor_x) / page_w,
        }

    def _resolve_anchor_placement(self, pdf_bytes: bytes,
                                  stored: dict) -> list[dict] | None:
        """
        Given a stored placement that may contain anchor data, search the
        current PDF for the single best-matching occurrence of the anchor text
        and return an adjusted placement for it.

        Only ONE placement is returned — the closest match to the stored anchor
        position.  Forms that genuinely require multiple signature placements
        (e.g. Observation of Teaching) are handled by
        _find_observation_form_placements before this method is ever called.
        Returning all occurrences caused forms with repeated section labels
        (e.g. two "Signature:" lines for two different parties) to receive an
        unwanted automatic second signature.

        Returns a one-item list, or None if no anchor is present or matched.
        """
        import difflib

        anchor = stored.get('anchor')
        if not anchor:
            return None

        target_norm = anchor.get('anchor_text_norm', '').strip()
        if not target_norm:
            return None

        reader   = PdfReader(io.BytesIO(pdf_bytes))
        page_num = int(anchor.get('anchor_page', stored.get('page', 0)))
        if page_num >= len(reader.pages):
            return None

        page   = reader.pages[page_num]
        page_w = float(page.mediabox.width)
        page_h = float(page.mediabox.height)

        text_pos = self._extract_text_positions(page)
        if not text_pos:
            return None

        stored_anchor_y_pts = anchor.get('anchor_y_frac', 0.5) * page_h
        MAX_DRIFT_FRAC = 0.30
        sig_dy = anchor.get('sig_dy', -0.04)
        sig_dx = anchor.get('sig_dx',  0.0)

        # Find the single best match: highest fuzzy score, tie-broken by
        # proximity to the stored anchor y position.
        best_score = 0.0
        best_match = None   # (tx, ty)

        for txt, tx, ty in text_pos:
            norm = re.sub(r'\s+', ' ', txt.strip().lower())
            if not norm:
                continue
            score = difflib.SequenceMatcher(None, target_norm, norm).ratio()
            if score < 0.75:
                continue
            if abs(ty - stored_anchor_y_pts) / page_h > MAX_DRIFT_FRAC:
                continue
            # Prefer higher score; among equal scores prefer closer y position
            drift = abs(ty - stored_anchor_y_pts)
            if score > best_score or (score == best_score and best_match and drift < abs(best_match[1] - stored_anchor_y_pts)):
                best_score = score
                best_match = (tx, ty)

        if best_match is None:
            return None

        tx, ty = best_match
        new_y = ty / page_h + sig_dy
        new_x = tx / page_w + sig_dx
        return [{
            **stored,
            'x': max(0.0, min(new_x, 0.95)),
            'y': max(0.0, min(new_y, 0.95)),
        }]

    # ── Placement memory ─────────────────────────────────────────────

    @property
    def _placement_memory_path(self) -> Path:
        return self.data_dir / 'placement_memory.json'

    @staticmethod
    def _placement_key(original_name: str) -> str:
        """Normalize a filename into a memory key.

        Strips trailing years (2020–2099) and version suffixes so that
        'MOU_2024.pdf' and 'MOU_2025.pdf' share the same remembered placement.
        """
        stem = Path(original_name).stem.lower()
        stem = re.sub(r'[\s_\-]+20\d{2}$', '', stem)   # trailing 4-digit year
        stem = re.sub(r'[\s_\-]+v?\d+$',   '', stem)   # trailing version number
        return stem.strip('_- ') or stem

    def get_remembered_placement(self, original_name: str,
                                  pdf_bytes: bytes | None = None) -> list | None:
        """Return remembered placements for this document type, or None.

        If pdf_bytes is supplied and stored placements contain anchor data,
        the returned coordinates are adjusted to follow the anchor's current
        position in the document (handles forms that shift between versions).
        """
        key = self._placement_key(original_name)
        try:
            memory = json.loads(self._placement_memory_path.read_text())
            stored = memory.get(key)
        except (FileNotFoundError, json.JSONDecodeError):
            stored = None

        if not stored:
            return None
        if not pdf_bytes:
            return stored

        resolved = []
        for p in stored:
            adjusted = self._resolve_anchor_placement(pdf_bytes, p)
            if adjusted is not None:
                resolved.extend(adjusted)   # one entry per anchor occurrence
            else:
                resolved.append(p)
        return resolved

    def remember_placement(self, original_name: str, placements: list,
                           pdf_bytes: bytes | None = None) -> None:
        """Persist placements for this document type to placement_memory.json.

        If pdf_bytes is supplied, anchor data (nearest text label above each
        signature) is computed and stored alongside the coordinates so that
        future sign operations can adapt when the form layout shifts.
        """
        key = self._placement_key(original_name)
        try:
            memory = json.loads(self._placement_memory_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            memory = {}

        enhanced = []
        for p in placements:
            ep = dict(p)
            if pdf_bytes:
                anchor = self._find_anchor_for_placement(pdf_bytes, p)
                if anchor:
                    ep['anchor'] = anchor
            enhanced.append(ep)

        memory[key] = enhanced
        self._placement_memory_path.write_text(json.dumps(memory, indent=2))

    def validate_remembered_placement(self, pdf_bytes: bytes, placement: dict) -> bool:
        """
        Check whether a remembered placement is still valid for this document.

        Looks for an AcroForm field or a chair/signature text label within
        ~1.4 inches of the remembered position.  If the page has no detectable
        content at all (scanned image), trust the memory unconditionally.
        Returns False when detectable content exists but nothing is near the
        remembered spot (i.e. the form has been refilled and fields shifted).
        """
        reader = PdfReader(io.BytesIO(pdf_bytes))
        page_num = int(placement.get('page', 0))
        if page_num >= len(reader.pages):
            return False

        page = reader.pages[page_num]
        page_w = float(page.mediabox.width)
        page_h = float(page.mediabox.height)

        # Centre of the remembered placement in PDF points
        px = (placement['x'] + placement.get('width', 0.28) / 2) * page_w
        py = (placement['y'] + placement.get('height', 0.08) / 2) * page_h
        TOLERANCE = 100  # ≈ 1.4 inches

        # Collect AcroForm fields on this page
        fields_on_page = []
        for ref in self._get_page_annots(page):
            try:
                a = ref.get_object()
            except Exception:
                continue
            rect = a.get('/Rect')
            if rect:
                x1, y1, x2, y2 = (float(v) for v in rect)
                fields_on_page.append(((x1 + x2) / 2, (y1 + y2) / 2))

        # Collect chair / signature text labels on this page
        text_pos = self._extract_text_positions(page)
        sig_labels = [
            (tx, ty) for txt, tx, ty in text_pos
            if self._CHAIR_RE.search(txt) or self._SIG_RE.search(txt)
        ]

        # Nothing detectable → scanned page; trust memory as-is
        if not fields_on_page and not sig_labels:
            return True

        # Something detectable exists — verify proximity
        for cx, cy in fields_on_page:
            if abs(cx - px) < TOLERANCE and abs(cy - py) < TOLERANCE:
                return True
        for tx, ty in sig_labels:
            if abs(tx - px) < TOLERANCE and abs(ty - py) < TOLERANCE:
                return True

        return False

    def process_document(self, file_path: str, original_filename: str,
                         placements: list,
                         signer_name: str = '',
                         name_placement: dict | None = None,
                         date_placement: dict | None = None,
                         name_placements: list | None = None,
                         date_placements: list | None = None,
                         text_annotations: list | None = None) -> tuple[str, str]:
        """
        Sign a PDF or DOCX file. Returns (output_filename, output_path).
        DOCX files are first converted to PDF, then signed.

        When placements is empty the method tries to auto-detect the
        chair/director signature field; falls back to bottom-right of page 1.

        Optionally stamps printed name and/or current date/time onto the PDF:
          signer_name    – text to render at name_placement (omitted if empty)
          name_placement – {page, x, y, font_size} for the printed name field
          date_placement – {page, x, y, font_size} for the date/time field
        """
        ext = Path(original_filename).suffix.lower()

        if ext == '.docx':
            pdf_bytes = self.docx_to_pdf_bytes(file_path)
        elif ext == '.pdf':
            with open(file_path, 'rb') as f:
                pdf_bytes = f.read()
        else:
            raise ValueError(f'Unsupported file type "{ext}". Upload a PDF or DOCX.')

        if not placements:
            placements = self.find_signature_field_placement(pdf_bytes) or [
                {'page': 0, 'x': 0.55, 'y': 0.05, 'width': 0.30, 'height': 0.08}
            ]

        signed_bytes = self.sign_pdf_bytes(pdf_bytes, placements)

        # Apply optional text overlays (name and/or date)
        text_by_page: dict[int, list] = {}
        now = datetime.now()
        now_str = f'{now.month}/{now.day}/{now.year}  {now.strftime("%I").lstrip("0") or "12"}:{now.strftime("%M")} {now.strftime("%p")}'

        # Merge legacy single placements with new list form
        all_name_pls = list(name_placements or [])
        if name_placement:
            all_name_pls.append(name_placement)
        all_date_pls = list(date_placements or [])
        if date_placement:
            all_date_pls.append(date_placement)

        for np in all_name_pls:
            if signer_name.strip():
                pg = int(np.get('page', 0))
                text_by_page.setdefault(pg, []).append({
                    'text':            signer_name.strip(),
                    'x':               np.get('x', 0.1),
                    'y':               np.get('y', 0.1),
                    'font_size':       np.get('font_size', 11),
                    'box_height_frac': np.get('height', np.get('box_height_frac', self._TEXT_BOX_H_FRAC)),
                })

        for dp in all_date_pls:
            pg = int(dp.get('page', 0))
            text_by_page.setdefault(pg, []).append({
                'text':            now_str,
                'x':               dp.get('x', 0.6),
                'y':               dp.get('y', 0.1),
                'font_size':       dp.get('font_size', 11),
                'box_height_frac': dp.get('height', dp.get('box_height_frac', self._TEXT_BOX_H_FRAC)),
            })

        # Apply arbitrary text annotations provided by the user
        for ta in (text_annotations or []):
            text = str(ta.get('text', '')).strip()
            if not text:
                continue
            pg = int(ta.get('page', 0))
            text_by_page.setdefault(pg, []).append({
                'text':            text,
                'x':               ta.get('x', 0.1),
                'y':               ta.get('y', 0.1),
                'font_size':       ta.get('font_size', 11),
                'box_height_frac': ta.get('height', ta.get('box_height_frac', self._TEXT_BOX_H_FRAC)),
            })

        if text_by_page:
            signed_bytes = self._apply_text_overlays(signed_bytes, text_by_page)

        stem = Path(original_filename).stem
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        out_name = f'{stem}_signed_{timestamp}.pdf'
        out_path = self.signed_dir / out_name
        with open(out_path, 'wb') as f:
            f.write(signed_bytes)

        return out_name, str(out_path)

    def list_signed_documents(self) -> list[dict]:
        docs = []
        for f in sorted(self.signed_dir.iterdir(), reverse=True):
            if f.suffix.lower() == '.pdf':
                stat = f.stat()
                docs.append({
                    'filename': f.name,
                    'size_kb': round(stat.st_size / 1024, 1),
                    'created': datetime.fromtimestamp(stat.st_ctime).strftime('%Y-%m-%d %H:%M'),
                })
        return docs


# ── Command-line interface ────────────────────────────────────────────────────

def _cli_detect(autopen: AutoPen, file_path: str) -> None:
    """Verbose detection: show every candidate and which strategy won."""
    path = Path(file_path)
    if not path.exists():
        print(f"ERROR: file not found: {file_path}")
        return

    with open(path, 'rb') as fh:
        pdf_bytes = fh.read()

    reader = PdfReader(io.BytesIO(pdf_bytes))
    print(f"\n{'='*60}")
    print(f"FILE: {path.name}")
    print(f"Pages: {len(reader.pages)}")
    print('='*60)

    # ── Pass A: text-scored AcroForm fields ──────────────────────────
    print("\n[Pass A] AcroForm fields scored by proximity to chair/sig label")
    candidates = []
    all_empty_ft = []

    for page_num, page in enumerate(reader.pages):
        page_w = float(page.mediabox.width)
        page_h = float(page.mediabox.height)
        text_pos = autopen._extract_text_positions(page)

        chair_sig_labels = [
            (txt, tx, ty) for txt, tx, ty in text_pos
            if autopen._CHAIR_RE.search(txt) or autopen._SIG_RE.search(txt)
        ]
        if chair_sig_labels:
            print(f"  Page {page_num}: found {len(chair_sig_labels)} chair/sig label(s):")
            for txt, tx, ty in chair_sig_labels:
                tag = []
                if autopen._CHAIR_RE.search(txt): tag.append('CHAIR')
                if autopen._SIG_RE.search(txt):   tag.append('SIG')
                print(f"    [{','.join(tag)}] y={ty:.1f} x={tx:.1f}  '{txt[:60]}'")

        for ref in autopen._get_page_annots(page):
            try:
                a = ref.get_object()
            except Exception:
                continue
            ft = str(a.get('/FT', 'TYPED'))
            if ft not in ('', 'TYPED'):
                continue
            rect = a.get('/Rect')
            if not rect:
                continue
            x1, y1, x2, y2 = (float(v) for v in rect)
            field_cx = (x1 + x2) / 2
            field_cy = (y1 + y2) / 2
            t_name  = str(a.get('/T',  '(unnamed)'))
            tu_name = str(a.get('/TU', ''))
            placement = {
                'page': page_num, 'x': x1/page_w, 'y': y1/page_h,
                'width': max((x2-x1)/page_w, 0.20),
                'height': max((y2-y1)/page_h, 0.03),
            }
            all_empty_ft.append((page_num, x1, y1, placement, t_name))

            best = float('inf')
            best_label = None
            for txt, tx, ty in text_pos:
                if autopen._CHAIR_RE.search(txt) or autopen._SIG_RE.search(txt):
                    above_penalty = 50 if field_cy > ty + 50 else 0
                    dist = abs(ty - field_cy) + abs(tx - field_cx) * 0.3 + above_penalty
                    if dist < best:
                        best = dist
                        best_label = txt[:50]

            mark = ' ✓ CANDIDATE' if best < 200 else ''
            print(f"  Page {page_num}: field '{t_name}' rect=[{x1:.0f},{y1:.0f},{x2:.0f},{y2:.0f}]"
                  f"  dist={best:.1f}  label='{best_label}'{mark}")
            if best < 200:
                candidates.append((best, page_num, placement, t_name, best_label))

    if candidates:
        candidates.sort(key=lambda c: c[0])
        winner = candidates[0]
        print(f"\n  → Pass A winner: page={winner[1]} field='{winner[3]}'"
              f"  dist={winner[0]:.1f}  label='{winner[4]}'")
        pl = winner[2]
        page = reader.pages[winner[1]]
        pw = float(page.mediabox.width)
        ph = float(page.mediabox.height)
        print(f"     Placement (fractions): x={pl['x']:.3f} y={pl['y']:.3f}"
              f" w={pl['width']:.3f} h={pl['height']:.3f}")
        print(f"     Placement (points):    x={pl['x']*pw:.1f} y={pl['y']*ph:.1f}"
              f" w={pl['width']*pw:.1f} h={pl['height']*ph:.1f}")
        print(f"\n✅ Strategy used: Pass A (AcroForm proximity)")
        return

    # ── Pass B: field name matches chair pattern ──────────────────────
    print("\n[Pass B] AcroForm field name / tooltip matches chair pattern")
    for page_num, page in enumerate(reader.pages):
        page_w = float(page.mediabox.width)
        page_h = float(page.mediabox.height)
        for ref in autopen._get_page_annots(page):
            try:
                a = ref.get_object()
            except Exception:
                continue
            t  = str(a.get('/T', ''))
            tu = str(a.get('/TU', ''))
            if autopen._CHAIR_RE.search(t) or autopen._CHAIR_RE.search(tu):
                rect = a.get('/Rect')
                if not rect:
                    continue
                x1, y1, x2, y2 = (float(v) for v in rect)
                pl = {'page': page_num, 'x': x1/page_w, 'y': y1/page_h,
                      'width': max((x2-x1)/page_w, 0.20),
                      'height': max((y2-y1)/page_h, 0.03)}
                print(f"  → Pass B winner: page={page_num} /T='{t}' /TU='{tu}'")
                print(f"     Placement (fractions): x={pl['x']:.3f} y={pl['y']:.3f}"
                      f" w={pl['width']:.3f} h={pl['height']:.3f}")
                print(f"     Placement (points):    x={x1:.1f} y={y1:.1f}"
                      f" w={x2-x1:.1f} h={y2-y1:.1f}")
                print(f"\n✅ Strategy used: Pass B (field name match)")
                return
    print("  No matching field names found.")

    # ── Pass C: bottom-most field on last page ────────────────────────
    print("\n[Pass C] Bottom-most empty AcroForm field on last page (scanned PDF fallback)")
    if all_empty_ft:
        last_page = max(p for p, *_ in all_empty_ft)
        on_last = [(x1, y1, pl, nm) for p, x1, y1, pl, nm in all_empty_ft if p == last_page]
        on_last.sort(key=lambda t: (t[1], t[0]))
        x1, y1, pl, nm = on_last[0]
        print(f"  All fields on page {last_page}:")
        for fx1, fy1, fpl, fnm in on_last:
            marker = ' ← selected' if fx1 == x1 and fy1 == y1 else ''
            print(f"    '{fnm}' x={fx1:.0f} y={fy1:.0f}{marker}")
        print(f"  → Pass C winner: field='{nm}' x={x1:.0f} y={y1:.0f}")
        page = reader.pages[last_page]
        pw = float(page.mediabox.width)
        ph = float(page.mediabox.height)
        print(f"     Placement (fractions): x={pl['x']:.3f} y={pl['y']:.3f}"
              f" w={pl['width']:.3f} h={pl['height']:.3f}")
        print(f"     Placement (points):    x={pl['x']*pw:.1f} y={pl['y']*ph:.1f}"
              f" w={pl['width']*pw:.1f} h={pl['height']*ph:.1f}")
        print(f"\n✅ Strategy used: Pass C (positional fallback)")
        return
    print("  No AcroForm fields found at all.")

    # ── Text-label scan ───────────────────────────────────────────────
    print("\n[Text-label scan] Looking for chair label + standalone Signature line")
    for page_num, page in enumerate(reader.pages):
        page_w = float(page.mediabox.width)
        page_h = float(page.mediabox.height)
        text_pos = autopen._extract_text_positions(page)

        chair_labels = [
            (ty, tx, txt) for txt, tx, ty in text_pos
            if autopen._CHAIR_RE.search(txt)
        ]
        if not chair_labels:
            continue

        print(f"  Page {page_num}: {len(chair_labels)} chair label(s):")
        for cy, cx, ct in sorted(chair_labels, reverse=True):
            print(f"    y={cy:.1f} x={cx:.1f}  '{ct[:60]}'")

        for chair_y, _cx, _ct in sorted(chair_labels, reverse=True):
            sig_cands = [
                (tx, ty) for txt, tx, ty in text_pos
                if autopen._SIG_RE.search(txt)
                and not autopen._CHAIR_RE.search(txt)
                and (chair_y - 120) <= ty <= chair_y
            ]
            if sig_cands:
                sig_x, sig_y = max(sig_cands, key=lambda p: p[0])
                sig_start_x = sig_x + page_w * 0.05
                if sig_start_x + page_w * 0.30 > page_w * 0.95:
                    sig_start_x = page_w * 0.40
                pl = {'page': page_num,
                      'x': sig_start_x / page_w,
                      'y': max(0.01, (sig_y - 12.5) / page_h),
                      'width': 0.30, 'height': 25.0 / page_h}
                print(f"    Sig line found: x={sig_x:.0f} y={sig_y:.0f} (within 120pt of chair)")
                print(f"  → Text-label Pass 1 winner")
                print(f"     Placement (fractions): x={pl['x']:.3f} y={pl['y']:.3f}"
                      f" w={pl['width']:.3f} h={pl['height']:.3f}")
                print(f"     Placement (points):    x={sig_start_x:.1f} y={sig_y-12.5:.1f}"
                      f" w={0.30*page_w:.1f} h=25.0")
                print(f"\n✅ Strategy used: Text-label Pass 1")
                return

        approval_labels = [t for t in chair_labels if autopen._APPROVAL_RE.search(t[2])]
        pool = approval_labels if approval_labels else chair_labels
        chair_y, _cx, _ct = sorted(pool)[0]
        pl = {'page': page_num, 'x': 0.55,
              'y': max(0.01, (chair_y - 10) / page_h),
              'width': 0.30, 'height': 25.0 / page_h}
        chosen_pool = 'approval' if approval_labels else 'all chair'
        print(f"    No standalone Sig line → using {chosen_pool} labels")
        print(f"  → Text-label Pass 2 winner: y={chair_y:.1f}")
        print(f"     Placement (fractions): x={pl['x']:.3f} y={pl['y']:.3f}"
              f" w={pl['width']:.3f} h={pl['height']:.3f}")
        print(f"     Placement (points):    x={0.55*page_w:.1f} y={chair_y-10:.1f}"
              f" w={0.30*page_w:.1f} h=25.0")
        print(f"\n✅ Strategy used: Text-label Pass 2")
        return

    print("\n❌ No strategy matched — would use hardcoded fallback:"
          " page=0 x=0.55 y=0.05 w=0.30 h=0.08")


def _cli_sign(autopen: AutoPen, file_path: str) -> None:
    path = Path(file_path)
    if not path.exists():
        print(f"ERROR: file not found: {file_path}")
        return
    if not autopen.has_signature():
        print(f"ERROR: no signature found in {autopen.signatures_dir}")
        print("Save a signature via the dashboard first (Settings → Signature).")
        return
    print(f"Signing: {path.name}")
    out_name, out_path = autopen.process_document(str(path), path.name, [])
    print(f"Saved:   {out_path}")


def _cli_list_signed(autopen: AutoPen) -> None:
    docs = autopen.list_signed_documents()
    if not docs:
        print("No signed documents found.")
        return
    print(f"{'Created':<17} {'Size':>8}  Filename")
    print('-' * 70)
    for d in docs:
        print(f"{d['created']:<17} {d['size_kb']:>7.1f}k  {d['filename']}")


if __name__ == '__main__':
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        prog='autopen',
        description='AutoPen — PDF signature placement tool',
    )
    parser.add_argument(
        '--data-dir',
        default=os.environ.get('AUTOPEN_DATA_DIR', './data'),
        help='Path to data directory (default: ./data or $AUTOPEN_DATA_DIR)',
    )

    sub = parser.add_subparsers(dest='command', required=True)

    p_detect = sub.add_parser('detect', help='Show signature field detection for a PDF')
    p_detect.add_argument('file', help='Path to the PDF file')

    p_sign = sub.add_parser('sign', help='Sign a PDF or DOCX using auto-detection')
    p_sign.add_argument('file', help='Path to the PDF or DOCX file')

    sub.add_parser('list-signed', help='List signed documents')

    args = parser.parse_args()

    pen = AutoPen(args.data_dir)

    if args.command == 'detect':
        _cli_detect(pen, args.file)
    elif args.command == 'sign':
        _cli_sign(pen, args.file)
    elif args.command == 'list-signed':
        _cli_list_signed(pen)
