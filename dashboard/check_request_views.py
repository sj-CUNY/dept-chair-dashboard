"""
Check Request Form Filler views.

Fills Bus.043 - Check Request Form PDF fields using pypdf,
signs the result with AutoPen, and lets the user download it.

Actual AcroForm field names (from template inspection):
  Buttons: 'Depository Check Box', 'Aux Corp Check Box',
           'When Ready Contact', 'Mail Check'
  Text:    'Check Amount', 'DATE', 'DATE REQUIRED',
           'Payee', 'Payee Address', 'City', 'STATE', 'ZIP',
           'FOR ATTENDING THE EVENT...' 1/2/3,
           'PRINT NAME', 'DATE_2', 'Print Name 3'

Note: There is no AcroForm field for "Foundation" in the template;
      when that type is selected, both Depository and Aux Corp are unchecked.

Vendors are persisted in data/check_vendors.json keyed by a
user-chosen label (usually the payee name).
"""

import io
import json
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, Http404, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from workflows.autopen import AutoPen

DATA_DIR      = settings.DATA_DIR
UPLOAD_DIR    = DATA_DIR / 'uploads'
SIGNED_DIR    = DATA_DIR / 'signed'
VENDORS_FILE  = DATA_DIR / 'check_vendors.json'
TEMPLATE_FILE = DATA_DIR / 'check_request_template.pdf'

for _d in [UPLOAD_DIR, SIGNED_DIR]:
    _d.mkdir(parents=True, exist_ok=True)

_autopen = AutoPen(DATA_DIR)


# ── helpers ──────────────────────────────────────────────────────────────────

def _load_vendors() -> dict:
    if VENDORS_FILE.exists():
        try:
            return json.loads(VENDORS_FILE.read_text())
        except Exception:
            pass
    return {}


def _save_vendors(vendors: dict) -> None:
    VENDORS_FILE.write_text(json.dumps(vendors, indent=2))


def _safe_path(directory: Path, filename: str) -> Path:
    resolved = (directory / Path(filename).name).resolve()
    if not str(resolved).startswith(str(directory.resolve())):
        raise ValueError('Invalid filename')
    return resolved


def _fill_check_request(template_path: Path, fields: dict) -> bytes:
    """
    Fill AcroForm fields in the check-request PDF template using pypdf.

    Uses auto_regenerate=True so pypdf bakes fresh /AP appearance streams
    directly into each widget annotation.  Those streams live on the page itself
    and survive any later PDF merge/overlay steps (e.g. signature stamping via
    autopen) that reconstruct the document without the root /AcroForm dictionary.
    This ensures field values are always visible regardless of PDF viewer.

    Returns the filled PDF bytes.
    """
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as exc:
        raise RuntimeError("pypdf is not installed — run: pip install pypdf") from exc

    reader = PdfReader(str(template_path))
    # clone_from copies the entire document structure including the AcroForm
    writer = PdfWriter(clone_from=reader)

    # Build PDF field dict — always set checkboxes explicitly so old values are cleared
    # Actual field names verified against the template's AcroForm annotations.
    def _cb(key):
        """Return '/Yes' or '/Off' for a checkbox field."""
        return '/Yes' if fields.get(key) else '/Off'

    pdf_fields = {
        # Checkboxes
        'Depository Check Box': _cb('depository'),
        'Aux Corp Check Box':   _cb('aux_corp'),
        'When Ready Contact':   _cb('when_ready'),
        'Mail Check':           _cb('mail_check'),
        # Text fields
        'Check Amount': str(fields.get('amount') or ''),
        'DATE':         str(fields.get('date') or ''),
        'DATE REQUIRED': str(fields.get('date_required') or ''),
        'Payee':         str(fields.get('payee') or ''),
        'Payee Address': str(fields.get('address') or ''),
        'City':          str(fields.get('city') or ''),
        'STATE':         str(fields.get('state') or ''),
        'ZIP':           str(fields.get('zip') or ''),
        'FOR ATTENDING THE EVENT Please attach an additional sheets if necessary 1':
            str(fields.get('desc1') or ''),
        'FOR ATTENDING THE EVENT Please attach an additional sheets if necessary 2':
            str(fields.get('desc2') or ''),
        'FOR ATTENDING THE EVENT Please attach an additional sheets if necessary 3':
            str(fields.get('desc3') or ''),
        'PRINT NAME':   str(fields.get('print_name') or ''),
        'DATE_2':       str(fields.get('sign_date') or ''),
        'Print Name 3': str(fields.get('phone') or ''),
    }

    # auto_regenerate=True: pypdf regenerates /AP appearance streams for every
    # text widget so the values are embedded in the page annotations — no reliance
    # on NeedAppearances or viewer-side regeneration.
    for page in writer.pages:
        writer.update_page_form_field_values(page, pdf_fields, auto_regenerate=True)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


# ── API views ────────────────────────────────────────────────────────────────

@require_GET
def list_cr_vendors(request):
    """GET /api/check-request/vendors — return saved vendor list."""
    return JsonResponse({'vendors': _load_vendors()})


@csrf_exempt
@require_POST
def save_cr_vendor(request):
    """POST /api/check-request/vendors/save — save a vendor entry."""
    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    label = (body.get('label') or '').strip()
    if not label:
        return JsonResponse({'error': 'label is required'}, status=400)

    vendors = _load_vendors()
    vendors[label] = {
        'payee':   (body.get('payee') or '').strip(),
        'address': (body.get('address') or '').strip(),
        'city':    (body.get('city') or '').strip(),
        'state':   (body.get('state') or '').strip(),
        'zip':     (body.get('zip') or '').strip(),
    }
    _save_vendors(vendors)
    return JsonResponse({'ok': True, 'vendors': vendors})


@csrf_exempt
def delete_cr_vendor(request, label):
    """DELETE /api/check-request/vendors/<label> — remove a vendor."""
    if request.method != 'DELETE':
        return JsonResponse({'error': 'DELETE required'}, status=405)
    vendors = _load_vendors()
    if label in vendors:
        del vendors[label]
        _save_vendors(vendors)
    return JsonResponse({'ok': True, 'vendors': vendors})


@require_GET
def cr_template_status(request):
    """GET /api/check-request/template-status — tell UI whether template exists."""
    return JsonResponse({'has_template': TEMPLATE_FILE.exists()})


@csrf_exempt
@require_POST
def cr_upload_template(request):
    """POST /api/check-request/upload-template — upload the blank check request PDF."""
    f = request.FILES.get('template')
    if not f:
        return JsonResponse({'error': 'No file'}, status=400)
    if not f.name.lower().endswith('.pdf'):
        return JsonResponse({'error': 'PDF required'}, status=400)
    with open(TEMPLATE_FILE, 'wb') as fp:
        for chunk in f.chunks():
            fp.write(chunk)
    return JsonResponse({'ok': True})


@csrf_exempt
@require_POST
def cr_generate(request):
    """
    POST /api/check-request/generate
    Body (JSON): {
      check_type:      'depository' | 'aux_corp' | 'john_jay_foundation'
      when_ready:      bool,
      mail_check:      bool,
      amount, date, date_required,
      payee, address, city, state, zip,
      desc1, desc2, desc3,
      print_name, sign_date, phone,
      save_vendor:   bool,
      vendor_label:  str  (defaults to payee name)
    }
    Returns: { ok, saved_filename }
    """
    if not TEMPLATE_FILE.exists():
        return JsonResponse({'error': 'Template PDF not uploaded yet.'}, status=400)

    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    def _b(key):
        """Coerce a value to bool."""
        v = body.get(key)
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            return v.lower() in ('true', 'yes', '1')
        return bool(v)

    check_type = (body.get('check_type') or 'depository').strip()

    fields = {
        # Check type — only one box can be checked
        'depository':    check_type == 'depository',
        'aux_corp':      check_type == 'aux_corp',
        # john_jay_foundation has no matching AcroForm field; both boxes stay off
        'when_ready':    _b('when_ready'),
        'mail_check':    _b('mail_check'),
        # Text
        'amount':        str(body.get('amount') or ''),
        'date':          str(body.get('date') or ''),
        'date_required': str(body.get('date_required') or ''),
        'payee':         str(body.get('payee') or ''),
        'address':       str(body.get('address') or ''),
        'city':          str(body.get('city') or ''),
        'state':         str(body.get('state') or ''),
        'zip':           str(body.get('zip') or ''),
        'desc1':         str(body.get('desc1') or ''),
        'desc2':         str(body.get('desc2') or ''),
        'desc3':         str(body.get('desc3') or ''),
        'print_name':    str(body.get('print_name') or ''),
        'sign_date':     str(body.get('sign_date') or ''),
        'phone':         str(body.get('phone') or ''),
    }

    # Optionally save vendor
    if _b('save_vendor'):
        vendor_label = (str(body.get('vendor_label') or fields['payee'])).strip()
        if vendor_label:
            vendors = _load_vendors()
            vendors[vendor_label] = {
                'payee':   fields['payee'],
                'address': fields['address'],
                'city':    fields['city'],
                'state':   fields['state'],
                'zip':     fields['zip'],
            }
            _save_vendors(vendors)

    try:
        filled_bytes = _fill_check_request(TEMPLATE_FILE, fields)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

    ts   = datetime.now().strftime('%Y%m%d_%H%M%S')
    dest = UPLOAD_DIR / f'{ts}_check_request.pdf'
    dest.write_bytes(filled_bytes)

    return JsonResponse({'ok': True, 'saved_filename': dest.name})


@csrf_exempt
@require_POST
def cr_sign_and_download(request):
    """
    POST /api/check-request/sign
    Body: { saved_filename, placement, signer_name }
    Returns the signed PDF as a file download.
    """
    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    saved_filename = body.get('saved_filename', '')
    placement      = body.get('placement')
    signer_name    = body.get('signer_name', '')

    try:
        src_path = _safe_path(UPLOAD_DIR, saved_filename)
    except ValueError:
        return JsonResponse({'error': 'Invalid filename'}, status=400)
    if not src_path.exists():
        return JsonResponse({'error': 'File not found'}, status=404)
    if placement is None:
        return JsonResponse({'error': 'placement required'}, status=400)

    try:
        out_name, _ = _autopen.process_document(
            str(src_path),
            src_path.name,
            placements=[placement],
            signer_name=signer_name,
        )
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

    out_path = _autopen.signed_dir / out_name
    return FileResponse(
        open(out_path, 'rb'),
        as_attachment=True,
        filename=out_name,
        content_type='application/pdf',
    )
