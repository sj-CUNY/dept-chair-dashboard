import base64
import json
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET

from workflows.autopen import AutoPen

DATA_DIR = settings.DATA_DIR
UPLOAD_DIR = DATA_DIR / 'uploads'
REPORTS_DIR = DATA_DIR / 'reports'

for _d in [UPLOAD_DIR, REPORTS_DIR]:
    _d.mkdir(parents=True, exist_ok=True)

autopen = AutoPen(DATA_DIR)

ALLOWED_SIGN   = {'.pdf', '.docx'}
ALLOWED_UPLOAD = {'.pdf', '.docx', '.xlsx', '.xls', '.csv'}


def _safe_path(directory: Path, filename: str) -> Path:
    resolved = (directory / Path(filename).name).resolve()
    if not str(resolved).startswith(str(directory.resolve())):
        raise ValueError('Invalid filename')
    return resolved


def _save_upload(django_file, prefix: str) -> Path:
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    dest = UPLOAD_DIR / f'{ts}_{prefix}_{django_file.name}'
    with open(dest, 'wb') as fp:
        for chunk in django_file.chunks():
            fp.write(chunk)
    return dest


# ── Dashboard ────────────────────────────────────────────────────────────────

def index(request):
    return render(request, 'index.html')


@require_GET
def api_status(request):
    return JsonResponse({'status': 'ok', 'timestamp': datetime.now().isoformat()})


# ── Reports ──────────────────────────────────────────────────────────────────

@require_GET
def list_reports(request):
    reports = []
    if REPORTS_DIR.exists():
        for f in sorted(REPORTS_DIR.iterdir(), reverse=True):
            if f.suffix in {'.xlsx', '.csv', '.pdf'}:
                stat = f.stat()
                reports.append({
                    'filename': f.name,
                    'size_kb': round(stat.st_size / 1024, 1),
                    'created': datetime.fromtimestamp(stat.st_ctime).strftime('%Y-%m-%d %H:%M'),
                })
    return JsonResponse({'reports': reports})


@require_GET
def download_report(request, filename):
    try:
        path = _safe_path(REPORTS_DIR, filename)
    except ValueError:
        raise Http404
    if not path.exists():
        raise Http404
    return FileResponse(open(path, 'rb'), as_attachment=True, filename=path.name)


# ── eHRAF Quality Check ──────────────────────────────────────────────────────

@csrf_exempt
def run_ehraf(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    saved = {}
    for key in ('schedule', 'ehraf', 'instructor'):
        if key not in request.FILES:
            return JsonResponse({'error': f'Missing file: {key}'}, status=400)
        f = request.FILES[key]
        if Path(f.name).suffix.lower() not in ALLOWED_UPLOAD:
            return JsonResponse({'error': f'Unsupported file type for "{key}"'}, status=400)
        saved[key] = str(_save_upload(f, key))

    try:
        from workflows.ehraf_quality_check import run as run_ehraf_check
        import time as _time
        output_path = str(REPORTS_DIR / f'ehraf_quality_{_time.strftime("%Y%m%d_%H%M%S")}.xlsx')
        result = run_ehraf_check(
            schedule_path=saved['schedule'],
            ehraf_path=saved['ehraf'],
            instructors_path=saved['instructor'],
            output_path=output_path,
        )
        report_path = result['output_path']
        return JsonResponse({'success': True, 'report': Path(report_path).name})
    except ImportError:
        return JsonResponse({'error': 'eHRAF workflow module not available'}, status=501)
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)


# ── Schedule Analysis ────────────────────────────────────────────────────────

@csrf_exempt
def run_schedule(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    if 'schedule' not in request.FILES:
        return JsonResponse({'error': 'Missing schedule file'}, status=400)

    save_path = _save_upload(request.FILES['schedule'], 'schedule')

    try:
        from workflows.schedule_analysis import run as run_schedule_analysis
        output_path   = str(REPORTS_DIR / f"schedule_report_{Path(save_path).stem}.xlsx")
        # Pass existing workbook so Config sheet (overrides + room caps) is preserved
        existing_wb   = output_path if Path(output_path).exists() else None
        result = run_schedule_analysis(
            schedule_path=str(save_path),
            output_path=output_path,
            existing_workbook_path=existing_wb,
            room_config_path=str(DATA_DIR / 'room_config.json'),
        )
        return JsonResponse({'success': True, 'report': Path(result['output_path']).name})
    except ImportError:
        return JsonResponse({'error': 'Schedule workflow module not available'}, status=501)
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)


# ── Autopen: signature ───────────────────────────────────────────────────────

@csrf_exempt
def autopen_signature(request):
    if request.method == 'GET':
        data_url = autopen.get_signature_data_url()
        return JsonResponse({'has_signature': data_url is not None, 'signature': data_url})

    if request.method == 'POST':
        try:
            body = json.loads(request.body)
        except json.JSONDecodeError:
            return JsonResponse({'error': 'Invalid JSON'}, status=400)
        sig = body.get('signature', '')
        if not sig or not sig.startswith('data:image/'):
            return JsonResponse({'error': 'Invalid signature data'}, status=400)
        autopen.save_signature(sig)
        return JsonResponse({'success': True})

    if request.method == 'DELETE':
        autopen.clear_signature()
        return JsonResponse({'success': True})

    return JsonResponse({'error': 'Method not allowed'}, status=405)


# ── Autopen: sign single document ────────────────────────────────────────────

@csrf_exempt
def sign_document(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    if 'file' not in request.FILES:
        return JsonResponse({'error': 'No file uploaded'}, status=400)

    f = request.FILES['file']
    if Path(f.name).suffix.lower() not in ALLOWED_SIGN:
        return JsonResponse({'error': 'Only PDF and DOCX files are supported'}, status=400)

    upload_path = _save_upload(f, 'doc')

    # Always show the placement picker — never sign without user confirmation.
    # Convert to PDF bytes so we can render pages and analyse the document.
    ext = Path(f.name).suffix.lower()
    try:
        if ext == '.docx':
            pdf_bytes = autopen.docx_to_pdf_bytes(str(upload_path))
        else:
            pdf_bytes = upload_path.read_bytes()
    except Exception as exc:
        return JsonResponse({'error': f'Could not read document: {exc}'}, status=500)

    try:
        n_pages = autopen.page_count(pdf_bytes)
    except Exception:
        n_pages = 1

    # Build a placement suggestion: memory (validated) → auto-detection → none
    suggestion = None
    suggestion_source = None

    remembered = autopen.get_remembered_placement(f.name, pdf_bytes=pdf_bytes)
    if remembered and autopen.validate_remembered_placement(pdf_bytes, remembered[0]):
        suggestion = remembered[0]
        suggestion_source = 'memory'
    else:
        detected = autopen.find_signature_field_placement(pdf_bytes)
        if detected:
            suggestion = detected[0]
            suggestion_source = 'detected'

    # Suggest a form name from PDF metadata / heading
    try:
        suggested_form_name = autopen.suggest_form_name(pdf_bytes)
    except Exception:
        suggested_form_name = ''

    return JsonResponse({
        'needs_placement':      True,
        'saved_filename':       upload_path.name,
        'page_count':           n_pages,
        'suggested_placement':  suggestion,
        'suggestion_source':    suggestion_source,
        'suggested_form_name':  suggested_form_name,
        'form_types':           autopen.list_form_types(),
    })


@require_GET
def preview_page(request, filename, page_num):
    """GET /api/autopen/preview/<filename>/<page_num>
    Returns a PNG image of the requested page for the placement picker.
    """
    try:
        path = _safe_path(UPLOAD_DIR, filename)
    except ValueError:
        raise Http404
    if not path.exists():
        raise Http404

    ext = path.suffix.lower()
    try:
        if ext == '.docx':
            pdf_bytes = autopen.docx_to_pdf_bytes(str(path))
        else:
            pdf_bytes = path.read_bytes()
        png_bytes = autopen.render_page_png(pdf_bytes, int(page_num))
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)

    return HttpResponse(png_bytes, content_type='image/png')


@csrf_exempt
def sign_with_placement(request):
    """POST /api/autopen/sign-placement
    Body: {
        saved_filename,
        placements:      [{page, x, y, width, height}],
        signer_name:     str (optional – printed name to stamp on form),
        name_placement:  {page, x, y, font_size} | null,
        date_placement:  {page, x, y, font_size} | null,
    }
    Signs a previously uploaded file using manually chosen coordinates.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)
    try:
        body = json.loads(request.body or b'{}')
    except ValueError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    filename        = body.get('saved_filename', '').strip()
    placements      = body.get('placements', [])
    signer_name     = body.get('signer_name', '').strip()

    # Accept both legacy single-object form and new array form; merge into lists
    def _to_list(val):
        if not val:
            return []
        return val if isinstance(val, list) else [val]

    name_placements  = _to_list(body.get('name_placements')) + _to_list(body.get('name_placement'))
    date_placements  = _to_list(body.get('date_placements')) + _to_list(body.get('date_placement'))
    text_annotations = [a for a in (body.get('text_annotations') or [])
                        if isinstance(a, dict) and a.get('text', '').strip()]

    if not filename or not placements:
        return JsonResponse({'error': 'saved_filename and placements required'}, status=400)

    try:
        path = _safe_path(UPLOAD_DIR, filename)
    except ValueError:
        return JsonResponse({'error': 'Invalid filename'}, status=400)
    if not path.exists():
        return JsonResponse({'error': 'File not found — please re-upload'}, status=404)

    # Recover the original filename from the timestamped upload name
    # Format: YYYYMMDD_HHMMSS_prefix_original  (split into 4 on first 3 underscores)
    parts = path.name.split('_', 3)
    original_name = parts[3] if len(parts) == 4 else path.name

    # Read PDF bytes (for anchor computation); skip expensive DOCX conversion
    _pdf_bytes_for_anchor = (
        path.read_bytes() if path.suffix.lower() == '.pdf' else None
    )

    try:
        out_name, _ = autopen.process_document(
            str(path), original_name, placements,
            signer_name=signer_name,
            name_placements=name_placements,
            date_placements=date_placements,
            text_annotations=text_annotations,
        )
        autopen.remember_placement(original_name, placements,
                                   pdf_bytes=_pdf_bytes_for_anchor)
        stamped = ['signature']
        if date_placements:
            stamped.append('date')
        if name_placements and signer_name:
            stamped.append('name')
        if text_annotations:
            stamped.append('text')
        return JsonResponse({'success': True, 'filename': out_name, 'stamped': stamped})
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({'error': f'Signing failed: {exc}'}, status=500)


# ── Autopen: upload batch (save files, return metadata for form-type selection) ──

@csrf_exempt
def upload_batch(request):
    """POST /api/autopen/upload-batch
    Saves uploaded files and returns the data needed to show the form-type
    select modal, without signing anything yet.

    FormData: files[]
    Response: {saved_filenames: [...], file_count: N, form_types: [...]}
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    files = request.FILES.getlist('files')
    if not files:
        return JsonResponse({'error': 'No files uploaded'}, status=400)

    saved = []
    for f in files:
        if Path(f.name).suffix.lower() not in ALLOWED_SIGN:
            return JsonResponse(
                {'error': f'{f.name}: only PDF and DOCX files are supported'}, status=400
            )
        upload_path = _save_upload(f, 'doc')
        saved.append(upload_path.name)

    return JsonResponse({
        'saved_filenames': saved,
        'file_count':      len(saved),
        'form_types':      autopen.list_form_types(),
    })


# ── Autopen: sign a batch of already-uploaded files with a form type ──────────

@csrf_exempt
def sign_batch_with_form_type(request):
    """POST /api/autopen/sign-batch-with-form-type
    Body: {saved_filenames: [...], form_type_name: str, signer_name: str (opt)}
    Signs every file in the list using the named form type's saved placements
    (signature, date, name).  Returns {results: [{filename, signed, success, stamped}]}
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)
    try:
        body = json.loads(request.body or b'{}')
    except ValueError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    saved_filenames = body.get('saved_filenames', [])
    form_type_name  = body.get('form_type_name', '').strip()
    signer_name     = body.get('signer_name', '').strip()

    if not saved_filenames or not form_type_name:
        return JsonResponse(
            {'error': 'saved_filenames and form_type_name required'}, status=400
        )

    ft_data = autopen.get_form_type_data(form_type_name)
    if not ft_data:
        return JsonResponse(
            {'error': f'Form type "{form_type_name}" not found'}, status=404
        )

    name_placement = ft_data.get('name_placement')
    date_placement = ft_data.get('date_placement')

    results = []
    for filename in saved_filenames:
        try:
            path = _safe_path(UPLOAD_DIR, filename)
        except ValueError:
            results.append({'filename': filename, 'error': 'Invalid filename', 'success': False})
            continue
        if not path.exists():
            results.append({'filename': filename, 'error': 'File not found — re-upload', 'success': False})
            continue

        _pdf_bytes_for_anchor = (
            path.read_bytes() if path.suffix.lower() == '.pdf' else None
        )
        placements = (
            autopen.get_resolved_form_type_placement(form_type_name, pdf_bytes=_pdf_bytes_for_anchor)
            or [ft_data['placement']]
        )

        parts = path.name.split('_', 3)
        original_name = parts[3] if len(parts) == 4 else path.name

        try:
            out_name, _ = autopen.process_document(
                str(path), original_name, placements,
                signer_name=signer_name,
                name_placement=name_placement,
                date_placement=date_placement,
            )
            stamped = ['signature']
            if date_placement:
                stamped.append('date')
            if name_placement and signer_name:
                stamped.append('name')
            results.append({
                'filename': filename,
                'original': original_name,
                'signed':   out_name,
                'success':  True,
                'stamped':  stamped,
            })
        except Exception as exc:
            results.append({'filename': filename, 'error': str(exc), 'success': False})

    return JsonResponse({'results': results})


# ── Autopen: sign multiple documents (legacy — kept for fallback) ─────────────

@csrf_exempt
def sign_multiple(request):
    """POST /api/autopen/sign-multiple
    FormData fields:
        files[]       – one or more PDF/DOCX files
        signer_name   – optional printed name (used if form type has name_placement)

    For each file, placement is resolved in priority order:
        1. Saved form type matched by filename (uses date/name placements too)
        2. Placement memory (previously signed filename)
        3. Auto-detected signature field
        4. Fall-back: bottom-right of page 1
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    files = request.FILES.getlist('files')
    if not files:
        return JsonResponse({'error': 'No files uploaded'}, status=400)

    signer_name = request.POST.get('signer_name', '').strip()

    results = []
    for f in files:
        if Path(f.name).suffix.lower() not in ALLOWED_SIGN:
            results.append({'filename': f.name, 'error': 'Unsupported type', 'success': False})
            continue

        upload_path = _save_upload(f, 'doc')
        ext = Path(f.name).suffix.lower()

        # Read PDF bytes once (needed for anchor resolution and memory lookup)
        try:
            if ext == '.docx':
                pdf_bytes = autopen.docx_to_pdf_bytes(str(upload_path))
            else:
                pdf_bytes = upload_path.read_bytes()
        except Exception as exc:
            results.append({'filename': f.name, 'error': f'Could not read file: {exc}', 'success': False})
            continue

        # ── Resolve placement + date/name ────────────────────────────────
        placement      = None
        name_placement = None
        date_placement = None
        placement_source = 'auto'

        # 1. Form type match
        ft_name = autopen.match_form_type_for_file(f.name, pdf_bytes=pdf_bytes)
        if ft_name:
            ft_data = autopen.get_form_type_data(ft_name)
            if ft_data:
                placement = (
                    autopen.get_resolved_form_type_placement(ft_name, pdf_bytes=pdf_bytes)
                    or ft_data['placement']
                )
                name_placement = ft_data.get('name_placement')
                date_placement = ft_data.get('date_placement')
                placement_source = f'form-type:{ft_name}'

        # 2. Placement memory
        if placement is None:
            remembered = autopen.get_remembered_placement(f.name, pdf_bytes=pdf_bytes)
            if remembered and autopen.validate_remembered_placement(pdf_bytes, remembered[0]):
                placement = remembered[0]
                placement_source = 'memory'

        # 3. Auto-detect
        if placement is None:
            detected = autopen.find_signature_field_placement(pdf_bytes)
            if detected:
                placement = detected[0]
                placement_source = 'detected'

        # 4. Fall-back (bottom-right)
        if placement is None:
            placement = {'page': 0, 'x': 0.55, 'y': 0.05, 'width': 0.30, 'height': 0.08}
            placement_source = 'default'

        try:
            out_name, _ = autopen.process_document(
                str(upload_path), f.name, [placement],
                signer_name=signer_name,
                name_placement=name_placement,
                date_placement=date_placement,
            )
            stamped = ['signature']
            if date_placement:
                stamped.append('date')
            if name_placement and signer_name:
                stamped.append('name')
            results.append({
                'filename':         f.name,
                'signed':           out_name,
                'success':          True,
                'placement_source': placement_source,
                'stamped':          stamped,
            })
        except Exception as exc:
            results.append({'filename': f.name, 'error': str(exc), 'success': False})

    return JsonResponse({'results': results})


@csrf_exempt
def sign_batch(request):
    """POST /api/autopen/sign-batch
    Multipart: files[] — multiple PDF/DOCX files (e.g. from a folder drop).
    Auto-matches each file against saved form types and signs matched ones.
    Returns:
      signed:    [{original_name, signed_name, form_type}]
      unmatched: [{original_name, saved_filename, page_count,
                   suggested_form_name, suggested_placement}]
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    files = request.FILES.getlist('files')
    if not files:
        return JsonResponse({'error': 'No files provided'}, status=400)

    signed    = []
    unmatched = []

    for f in files:
        ext = Path(f.name).suffix.lower()
        if ext not in ALLOWED_SIGN:
            continue   # silently skip unsupported types

        upload_path = _save_upload(f, 'batch')

        # Convert to PDF bytes for analysis
        try:
            pdf_bytes = (
                autopen.docx_to_pdf_bytes(str(upload_path))
                if ext == '.docx'
                else upload_path.read_bytes()
            )
        except Exception as exc:
            unmatched.append({
                'original_name':      f.name,
                'saved_filename':     upload_path.name,
                'page_count':         1,
                'suggested_form_name': '',
                'suggested_placement': None,
                'error':              str(exc),
            })
            continue

        # Try auto-match
        match = autopen.find_matching_form_type(pdf_bytes, f.name)

        if match:
            form_type_name, placement = match
            try:
                out_name, _ = autopen.process_document(
                    str(upload_path), f.name, [placement]
                )
                signed.append({
                    'original_name': f.name,
                    'signed_name':   out_name,
                    'form_type':     form_type_name,
                })
                continue
            except Exception:
                pass   # fall through to unmatched on signing failure

        # No match (or signing failed) — queue for manual placement
        try:
            n_pages = autopen.page_count(pdf_bytes)
        except Exception:
            n_pages = 1

        suggested_form_name = ''
        try:
            suggested_form_name = autopen.suggest_form_name(pdf_bytes)
        except Exception:
            pass

        suggestion = None
        try:
            det = autopen.find_signature_field_placement(pdf_bytes)
            if det:
                suggestion = det[0]
        except Exception:
            pass

        unmatched.append({
            'original_name':       f.name,
            'saved_filename':      upload_path.name,
            'page_count':          n_pages,
            'suggested_form_name': suggested_form_name,
            'suggested_placement': suggestion,
        })

    return JsonResponse({'signed': signed, 'unmatched': unmatched})


# ── Autopen: list & download signed documents ─────────────────────────────────

@require_GET
def list_signed_documents(request):
    return JsonResponse({'documents': autopen.list_signed_documents()})


@require_GET
def download_signed(request, filename):
    try:
        path = _safe_path(DATA_DIR / 'signed', filename)
    except ValueError:
        raise Http404
    if not path.exists():
        raise Http404
    return FileResponse(open(path, 'rb'), as_attachment=True, filename=path.name)


# ── Autopen: form type registry ──────────────────────────────────────────────

@csrf_exempt
def manage_form_types(request):
    """GET  /api/autopen/form-types  → {form_types: [...]}
       POST /api/autopen/form-types  body: {name, placement} → save"""
    if request.method == 'GET':
        return JsonResponse({'form_types': autopen.list_form_types()})
    if request.method == 'POST':
        try:
            body = json.loads(request.body or b'{}')
        except ValueError:
            return JsonResponse({'error': 'Invalid JSON'}, status=400)
        name           = body.get('name', '').strip()
        placement      = body.get('placement')
        name_placement = body.get('name_placement') or None
        date_placement = body.get('date_placement') or None
        text_placements = body.get('text_placements') or []
        saved_filename = body.get('saved_filename', '').strip()
        if not name or not placement:
            return JsonResponse({'error': 'name and placement required'}, status=400)
        # Compute anchor from the uploaded PDF if available
        _pdf_bytes = None
        if saved_filename:
            try:
                fp = _safe_path(UPLOAD_DIR, saved_filename)
                if fp.exists() and fp.suffix.lower() == '.pdf':
                    _pdf_bytes = fp.read_bytes()
            except Exception:
                pass
        autopen.save_form_type(name, placement,
                               name_placement=name_placement,
                               date_placement=date_placement,
                               text_placements=text_placements,
                               pdf_bytes=_pdf_bytes)
        return JsonResponse({'success': True, 'name': name})
    return JsonResponse({'error': 'Method not allowed'}, status=405)


@csrf_exempt
def delete_form_type_view(request, name):
    """DELETE /api/autopen/form-types/<name>
       PATCH  /api/autopen/form-types/<name>  body: {new_name, placement?, name_placement?, date_placement?}
    """
    if request.method == 'DELETE':
        found = autopen.delete_form_type(name)
        if not found:
            return JsonResponse({'error': 'Form type not found'}, status=404)
        return JsonResponse({'success': True})

    if request.method == 'PATCH':
        try:
            body = json.loads(request.body or b'{}')
        except ValueError:
            return JsonResponse({'error': 'Invalid JSON'}, status=400)
        new_name       = (body.get('new_name') or '').strip()
        if not new_name:
            return JsonResponse({'error': 'new_name is required'}, status=400)
        placement      = body.get('placement') or None
        name_placement = body.get('name_placement') or None
        date_placement = body.get('date_placement') or None
        text_placements = body.get('text_placements') or None
        found = autopen.rename_form_type(
            name, new_name,
            placement=placement,
            name_placement=name_placement,
            date_placement=date_placement,
            text_placements=text_placements,
        )
        if not found:
            return JsonResponse({'error': 'Form type not found'}, status=404)
        return JsonResponse({'success': True, 'name': new_name})

    return JsonResponse({'error': 'DELETE or PATCH required'}, status=405)


@csrf_exempt
def clear_signed_documents(request):
    """DELETE /api/autopen/signed/all — delete every file in the signed/ dir."""
    if request.method != 'DELETE':
        return JsonResponse({'error': 'DELETE required'}, status=405)
    signed_dir = DATA_DIR / 'signed'
    count = 0
    if signed_dir.exists():
        for f in signed_dir.iterdir():
            if f.is_file():
                f.unlink()
                count += 1
    return JsonResponse({'success': True, 'deleted': count})


@csrf_exempt
def clear_upload_queue(request):
    """DELETE /api/autopen/uploads/all — delete every file in the uploads/ dir."""
    if request.method != 'DELETE':
        return JsonResponse({'error': 'DELETE required'}, status=405)
    count = 0
    if UPLOAD_DIR.exists():
        for f in UPLOAD_DIR.iterdir():
            if f.is_file():
                f.unlink()
                count += 1
    return JsonResponse({'success': True, 'deleted': count})


@csrf_exempt
def detect_placements(request):
    """POST /api/autopen/detect-placements
    Body: {saved_filename, form_type_name (optional)}
    Returns detected/form-type signature placements for a pre-uploaded file
    without signing it.  Used to populate the batch-review placement picker.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)
    try:
        body = json.loads(request.body or b'{}')
    except ValueError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    filename       = body.get('saved_filename', '').strip()
    form_type_name = body.get('form_type_name', '').strip()
    if not filename:
        return JsonResponse({'error': 'saved_filename required'}, status=400)

    try:
        path = _safe_path(UPLOAD_DIR, filename)
    except ValueError:
        return JsonResponse({'error': 'Invalid filename'}, status=400)
    if not path.exists():
        return JsonResponse({'error': 'File not found'}, status=404)

    try:
        pdf_bytes  = path.read_bytes() if path.suffix.lower() == '.pdf' else None
        page_count = autopen.page_count(pdf_bytes) if pdf_bytes else 1

        if form_type_name:
            placements = autopen.get_resolved_form_type_placement(
                form_type_name, pdf_bytes=pdf_bytes
            ) or [autopen.get_form_type_data(form_type_name)['placement']]
            source = 'memory'
        elif pdf_bytes:
            placements = autopen.find_signature_field_placement(pdf_bytes)
            source = 'detected'
        else:
            placements = None
            source = None

        if not placements:
            placements = [{'page': 0, 'x': 0.55, 'y': 0.05, 'width': 0.30, 'height': 0.08}]
            source = 'fallback'

        return JsonResponse({
            'placements':        placements,
            'page_count':        page_count,
            'suggestion_source': source,
        })
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)


@csrf_exempt
def sign_batch_with_placements(request):
    """POST /api/autopen/sign-batch-with-placements
    Body: {saved_filenames, placements, signer_name, name_placement, date_placement}
    Signs every file with the exact explicit placements provided.
    Does NOT call remember_placement (one-shot use; each file is different).
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)
    try:
        body = json.loads(request.body or b'{}')
    except ValueError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    saved_filenames = body.get('saved_filenames', [])
    placements      = body.get('placements', [])
    signer_name     = body.get('signer_name', '').strip()
    name_placement  = body.get('name_placement')
    date_placement  = body.get('date_placement')

    if not saved_filenames or not placements:
        return JsonResponse(
            {'error': 'saved_filenames and placements are required'}, status=400
        )

    results = []
    for filename in saved_filenames:
        try:
            path = _safe_path(UPLOAD_DIR, filename)
        except ValueError:
            results.append({'filename': filename, 'error': 'Invalid filename', 'success': False})
            continue
        if not path.exists():
            results.append({'filename': filename, 'error': 'File not found — re-upload', 'success': False})
            continue

        parts         = path.name.split('_', 3)
        original_name = parts[3] if len(parts) == 4 else path.name

        try:
            out_name, _ = autopen.process_document(
                str(path), original_name, placements,
                signer_name=signer_name,
                name_placement=name_placement,
                date_placement=date_placement,
            )
            stamped = ['signature']
            if date_placement:
                stamped.append('date')
            if name_placement and signer_name:
                stamped.append('name')
            results.append({
                'filename': filename,
                'original': original_name,
                'signed':   out_name,
                'success':  True,
                'stamped':  stamped,
            })
        except Exception as exc:
            results.append({'filename': filename, 'error': str(exc), 'success': False})

    return JsonResponse({'results': results})


@csrf_exempt
def sign_with_form_type(request):
    """POST /api/autopen/sign-with-form-type
    Body: {saved_filename, form_type_name, signer_name (optional)}
    Signs immediately using the remembered placement for the named form type,
    including any remembered name/date placements.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)
    try:
        body = json.loads(request.body or b'{}')
    except ValueError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    filename       = body.get('saved_filename', '').strip()
    form_type_name = body.get('form_type_name', '').strip()
    signer_name    = body.get('signer_name', '').strip()
    if not filename or not form_type_name:
        return JsonResponse({'error': 'saved_filename and form_type_name required'}, status=400)

    ft_data = autopen.get_form_type_data(form_type_name)
    if not ft_data:
        return JsonResponse({'error': f'Form type "{form_type_name}" not found'}, status=404)

    name_placement = ft_data.get('name_placement')
    date_placement = ft_data.get('date_placement')

    try:
        path = _safe_path(UPLOAD_DIR, filename)
    except ValueError:
        return JsonResponse({'error': 'Invalid filename'}, status=400)
    if not path.exists():
        return JsonResponse({'error': 'File not found — please re-upload'}, status=404)

    # Resolve anchor-adjusted signature placements against the current document
    _pdf_bytes_for_anchor = (
        path.read_bytes() if path.suffix.lower() == '.pdf' else None
    )
    placements = (
        autopen.get_resolved_form_type_placement(form_type_name, pdf_bytes=_pdf_bytes_for_anchor)
        or [ft_data['placement']]
    )

    parts         = path.name.split('_', 3)
    original_name = parts[3] if len(parts) == 4 else path.name

    try:
        out_name, _ = autopen.process_document(
            str(path), original_name, placements,
            signer_name=signer_name,
            name_placement=name_placement,
            date_placement=date_placement,
        )
        stamped = ['signature']
        if date_placement:
            stamped.append('date')
        if name_placement and signer_name:
            stamped.append('name')
        return JsonResponse({'success': True, 'filename': out_name, 'stamped': stamped})
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({'error': f'Signing failed: {exc}'}, status=500)


# ── Outlook Add-in static file serving ───────────────────────────────────────

def serve_addin_file(request, filename):
    """Serve Outlook add-in static files (taskpane.html, taskpane.js, manifest.xml)."""
    import mimetypes
    from django.http import HttpResponse
    # Sanitize — only allow simple filenames with no path components
    if '/' in filename or '\\' in filename or '..' in filename:
        raise Http404
    addin_dir = Path(settings.BASE_DIR) / 'outlook-addin'
    file_path = addin_dir / filename
    if not file_path.exists():
        raise Http404
    ct, _ = mimetypes.guess_type(str(file_path))
    return HttpResponse(file_path.read_bytes(), content_type=ct or 'application/octet-stream')


# ── Room Config (Schedule Analysis) ─────────────────────────────────────────

import json as _json

@csrf_exempt
def get_room_config(request):
    """Return saved room config [{name, capacity}, ...]"""
    config_path = DATA_DIR / 'room_config.json'
    if config_path.exists():
        return JsonResponse({'rooms': _json.loads(config_path.read_text())})
    return JsonResponse({'rooms': []})

@csrf_exempt
def save_room_config(request):
    """Save room config [{name, capacity}, ...] from POST body."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)
    try:
        rooms = _json.loads(request.body)
        if not isinstance(rooms, list):
            raise ValueError('Expected list')
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        (DATA_DIR / 'room_config.json').write_text(_json.dumps(rooms, indent=2))
        return JsonResponse({'saved': len(rooms)})
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=400)
