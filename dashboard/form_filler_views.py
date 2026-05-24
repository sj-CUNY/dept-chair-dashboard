"""
Generic PDF Form Filler views.

Allows uploading arbitrary AcroForm PDFs, inspecting their fields,
storing per-template metadata, and filling/generating completed PDFs.

Storage layout:
  data/form_templates/        — uploaded blank PDF templates
  data/form_templates.json    — template metadata (fields, labels, types)
  data/uploads/               — filled (generated) PDFs

Metadata schema (form_templates.json):
  {
    "Template Name": {
      "name":     "Template Name",
      "filename": "Template Name.pdf",
      "fields": [
        {
          "pdf_name":       "FieldName",
          "label":          "Human label",
          "field_type":     "text" | "checkbox" | "radio" | "select",
          "default":        "",
          "profile_source": null
        },
        ...
      ]
    }
  }
"""

import io
import json
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET

from workflows.autopen import AutoPen

DATA_DIR       = settings.DATA_DIR
TEMPLATES_DIR  = DATA_DIR / 'form_templates'
TEMPLATES_META = DATA_DIR / 'form_templates.json'
UPLOAD_DIR     = DATA_DIR / 'uploads'

TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

_autopen = AutoPen(DATA_DIR)


# ── helpers ───────────────────────────────────────────────────────────────────

def _safe_path(directory: Path, filename: str) -> Path:
    """Resolve filename inside directory, rejecting path-traversal attempts."""
    resolved = (directory / Path(filename).name).resolve()
    if not str(resolved).startswith(str(directory.resolve())):
        raise ValueError('Invalid filename')
    return resolved


def _load_meta() -> dict:
    if TEMPLATES_META.exists():
        try:
            return json.loads(TEMPLATES_META.read_text())
        except Exception:
            pass
    return {}


def _save_meta(meta: dict) -> None:
    TEMPLATES_META.write_text(json.dumps(meta, indent=2))


def _detect_field_type(field) -> str:
    """
    Determine AcroForm field type from a pypdf Field object.

    Mapping:
      /Tx              → "text"
      /Btn, bit 15 set → "radio"   (bit 15 = Radio flag in /Ff)
      /Btn             → "checkbox"
      /Ch              → "select"
    """
    try:
        ft = field.field_type
    except Exception:
        return 'text'

    if ft == '/Tx':
        return 'text'
    if ft == '/Ch':
        return 'select'
    if ft == '/Btn':
        # Bit 15 (0-indexed) of /Ff distinguishes radio buttons from checkboxes.
        try:
            ff = int(field.field_flags or 0)
        except Exception:
            ff = 0
        return 'radio' if (ff >> 15) & 1 else 'checkbox'
    return 'text'


def _inspect_fields(pdf_path: Path) -> list:
    """
    Read AcroForm fields from pdf_path using pypdf and return an initial
    field list with pdf_name, label, field_type, default, profile_source.
    """
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError("pypdf is not installed — run: pip install pypdf") from exc

    reader = PdfReader(str(pdf_path))
    raw = reader.get_fields() or {}

    fields = []
    for pdf_name, field in raw.items():
        fields.append({
            'pdf_name':       pdf_name,
            'label':          pdf_name,
            'field_type':     _detect_field_type(field),
            'default':        '',
            'profile_source': None,
        })
    return fields


def _fill_template(template_path: Path, field_values: dict) -> bytes:
    """
    Fill AcroForm fields in template_path using pypdf.

    Uses auto_regenerate=True so pypdf bakes /AP appearance streams directly
    into each widget annotation — values are visible in all PDF viewers without
    depending on NeedAppearances or viewer-side regeneration.
    """
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as exc:
        raise RuntimeError("pypdf is not installed — run: pip install pypdf") from exc

    reader = PdfReader(str(template_path))
    writer = PdfWriter(clone_from=reader)

    for page in writer.pages:
        writer.update_page_form_field_values(page, field_values, auto_regenerate=True)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


# ── API views ─────────────────────────────────────────────────────────────────

@csrf_exempt
def ff_upload(request):
    """
    POST /api/form-filler/upload
    Multipart: template (PDF file), name (string)

    Saves the PDF to TEMPLATES_DIR, inspects its AcroForm fields, and stores
    initial metadata.  Returns the discovered field list so the caller can
    review/edit labels before use.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    name = (request.POST.get('name') or '').strip()
    if not name:
        return JsonResponse({'error': 'name is required'}, status=400)

    uploaded = request.FILES.get('template')
    if not uploaded:
        return JsonResponse({'error': 'template file is required'}, status=400)
    if not uploaded.name.lower().endswith('.pdf'):
        return JsonResponse({'error': 'PDF required'}, status=400)

    # Save PDF
    try:
        dest = _safe_path(TEMPLATES_DIR, f"{name}.pdf")
    except ValueError:
        return JsonResponse({'error': 'Invalid template name'}, status=400)

    with open(dest, 'wb') as fp:
        for chunk in uploaded.chunks():
            fp.write(chunk)

    # Inspect AcroForm fields
    try:
        fields = _inspect_fields(dest)
    except Exception as e:
        return JsonResponse({'error': f'Field inspection failed: {e}'}, status=500)

    # Persist metadata
    meta = _load_meta()
    meta[name] = {
        'name':     name,
        'filename': dest.name,
        'fields':   fields,
    }
    _save_meta(meta)

    return JsonResponse({'ok': True, 'name': name, 'fields': fields})


@require_GET
def ff_list(request):
    """GET /api/form-filler/templates — return all template metadata."""
    meta = _load_meta()
    return JsonResponse({'templates': list(meta.values())})


@require_GET
def ff_get(request, name):
    """GET /api/form-filler/templates/<name> — return metadata for one template."""
    meta = _load_meta()
    if name not in meta:
        return JsonResponse({'error': 'Template not found'}, status=404)
    return JsonResponse({'template': meta[name]})


@csrf_exempt
def ff_update(request, name):
    """
    POST /api/form-filler/templates/<name>/update
    Body (JSON): { "fields": [...] }

    Replaces the field list for the named template (allows editing labels,
    defaults, and profile_source mappings without re-uploading the PDF).
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    meta = _load_meta()
    if name not in meta:
        return JsonResponse({'error': 'Template not found'}, status=404)

    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    fields = body.get('fields')
    if fields is None or not isinstance(fields, list):
        return JsonResponse({'error': 'fields list is required'}, status=400)

    meta[name]['fields'] = fields
    _save_meta(meta)
    return JsonResponse({'ok': True})


@csrf_exempt
def ff_delete(request, name):
    """
    DELETE /api/form-filler/templates/<name>

    Removes the PDF file and metadata entry for the named template.
    """
    if request.method != 'DELETE':
        return JsonResponse({'error': 'DELETE required'}, status=405)

    meta = _load_meta()
    if name not in meta:
        return JsonResponse({'error': 'Template not found'}, status=404)

    # Remove PDF file if it exists
    filename = meta[name].get('filename', f"{name}.pdf")
    try:
        pdf_path = _safe_path(TEMPLATES_DIR, filename)
        if pdf_path.exists():
            pdf_path.unlink()
    except (ValueError, OSError):
        pass  # Best-effort removal; proceed with metadata deletion

    del meta[name]
    _save_meta(meta)
    return JsonResponse({'ok': True})


@csrf_exempt
def ff_generate(request, name):
    """
    POST /api/form-filler/templates/<name>/generate
    Body (JSON): {
      "field_values":  { "pdf_field_name": "value", ... },
      "signer_name":   "..."   (optional, reserved for future signing step)
    }

    Fills the named template with the provided field values, saves the result
    to UPLOAD_DIR, and returns the saved filename.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    meta = _load_meta()
    if name not in meta:
        return JsonResponse({'error': 'Template not found'}, status=404)

    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    field_values = body.get('field_values')
    if field_values is None or not isinstance(field_values, dict):
        return JsonResponse({'error': 'field_values dict is required'}, status=400)

    # signer_name is accepted but reserved for a future signing step
    signer_name = str(body.get('signer_name') or '').strip()  # noqa: F841

    filename = meta[name].get('filename', f"{name}.pdf")
    try:
        template_path = _safe_path(TEMPLATES_DIR, filename)
    except ValueError:
        return JsonResponse({'error': 'Invalid template filename'}, status=400)

    if not template_path.exists():
        return JsonResponse({'error': 'Template PDF not found on disk'}, status=404)

    try:
        filled_bytes = _fill_template(template_path, field_values)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

    ts           = datetime.now().strftime('%Y%m%d_%H%M%S')
    safe_name    = Path(name).name  # strip any residual path characters
    out_filename = f"{ts}_{safe_name}.pdf"
    out_path     = UPLOAD_DIR / out_filename
    out_path.write_bytes(filled_bytes)

    return JsonResponse({'ok': True, 'saved_filename': out_filename})
