"""
Travel Voucher Form Filler views.

Fills the E-Travel Expense Voucher PDF fields using pypdf (via
fill_etravel_voucher.fill_pdf), optionally flattens with Ghostscript,
and returns download links for each filled voucher.

Profile stored at:  data/travel_profile.json
Template PDF at:    data/etravel_voucher_template.pdf
Filled PDFs in:     data/signed/
"""

import json
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, Http404, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

DATA_DIR      = settings.DATA_DIR
UPLOAD_DIR    = DATA_DIR / 'uploads'
SIGNED_DIR    = DATA_DIR / 'signed'
PROFILE_FILE  = DATA_DIR / 'travel_profile.json'
TEMPLATE_FILE = DATA_DIR / 'etravel_voucher_template.pdf'

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
SIGNED_DIR.mkdir(parents=True, exist_ok=True)

# ── helpers ───────────────────────────────────────────────────────────────────

_DEFAULT_PROFILE = {
    "name": "",
    "address1": "",
    "address2": "",
    "city": "",
    "state": "",
    "zip": "",
    "is_citizen": True,
    "mileage_rate": "0.70",
    "sign_date": "",
}


def _load_profile() -> dict:
    if PROFILE_FILE.exists():
        try:
            return json.loads(PROFILE_FILE.read_text())
        except Exception:
            pass
    return dict(_DEFAULT_PROFILE)


def _save_profile(profile: dict) -> None:
    PROFILE_FILE.write_text(json.dumps(profile, indent=2))


def _safe_path(directory: Path, filename: str) -> Path:
    resolved = (directory / Path(filename).name).resolve()
    if not str(resolved).startswith(str(directory.resolve())):
        raise ValueError('Invalid filename')
    return resolved


# Category prefix / total-field names (mirrors fill_etravel_voucher.py)
_CATEGORY_PREFIX = {
    "meals":          "Meals",
    "transportation": "Transportation",
    "lodging":        "Lodging",
    "local_travel":   "Local Travel",
}
_CATEGORY_TOTAL = {
    "meals":          "Meals Total",
    "transportation": "Transportation Total",
    "lodging":        "Lodging Total",
    "local_travel":   "Local Travel Total",
}
_ZERO_TOTALS = [
    "Transportation Total", "Lodging Total", "Local Travel Total",
    "Miles Total", "Other 1 Total", "Other 2 Total", "Other 3 Total",
]


_MAX_DAYS = 7  # template rows .0 – .6


def _entry_amount(entry) -> float:
    if isinstance(entry, dict):
        return float(entry.get("amount", 0) or 0)
    return float(entry[1])


def _build_fields(traveler: dict, days: list) -> tuple:
    """Build the AcroForm field dict for all days in one voucher.

    The template has rows .0–.6 (one per day).  Each category gets one
    summed amount per row; totals and grand total are computed across all days.
    """
    is_citizen = traveler.get("is_citizen", True)
    first = days[0] if days else {}

    fields: dict = {
        "Name":               traveler.get("name", ""),
        "Mailing Address 1":  traveler.get("address1", ""),
        "Mailing Address 2":  traveler.get("address2", ""),
        "City":               traveler.get("city", ""),
        "State":              traveler.get("state", ""),
        "Zip Code":           traveler.get("zip", ""),
        "Yes":                "/Yes" if is_citizen else "/Off",
        "NO":                 "/Off" if is_citizen else "/Yes",
        "$ of MIles":         traveler.get("mileage_rate", "0.70"),
        "Date4_af_date":      first.get("sign_date") or traveler.get("sign_date", ""),
        "Purpose of Trip 2":  (
            first.get("purpose")
            or f"Hiring expenses - Job Talk: {first.get('candidate', '')} on {first.get('trip_date', '')}"
        ),
    }

    cat_totals = {cat: 0.0 for cat in _CATEGORY_PREFIX}
    grand_total = 0.0

    for row, day in enumerate(days[:_MAX_DAYS]):
        fields[f"Date.{row}"]             = day.get("trip_date", "")
        fields[f"Depature City.{row}"]    = day.get("departure_city", "")
        fields[f"Destination City.{row}"] = day.get("destination_city", "New York, NY")

        for cat, prefix in _CATEGORY_PREFIX.items():
            entries = day.get(cat) or []
            row_total = sum(_entry_amount(e) for e in entries)
            fields[f"{prefix}.{row}"] = f"{row_total:.2f}" if row_total else ""
            cat_totals[cat] += row_total
            grand_total += row_total

    for cat, prefix in _CATEGORY_PREFIX.items():
        fields[_CATEGORY_TOTAL[cat]] = f"{cat_totals[cat]:.2f}"

    for tf in _ZERO_TOTALS:
        fields.setdefault(tf, "0.00")

    fields["Total Expenses.0"] = f"{grand_total:.2f}"
    fields["Total Expenses.1"] = f"{grand_total:.2f}"

    return fields, grand_total


# ── API views ─────────────────────────────────────────────────────────────────

@require_GET
def get_profile(request):
    """GET /api/travel/profile → { profile: {...} }"""
    return JsonResponse({"profile": _load_profile()})


@csrf_exempt
@require_POST
def save_profile_view(request):
    """POST /api/travel/profile/save → { ok, profile }"""
    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    profile = _load_profile()
    allowed = {"name", "address1", "address2", "city", "state", "zip",
               "is_citizen", "mileage_rate", "sign_date"}
    for key in allowed:
        if key in body:
            profile[key] = body[key]

    _save_profile(profile)
    return JsonResponse({"ok": True, "profile": profile})


@require_GET
def tv_template_status(request):
    """GET /api/travel/template-status → { has_template: bool }"""
    return JsonResponse({"has_template": TEMPLATE_FILE.exists()})


@csrf_exempt
@require_POST
def tv_upload_template(request):
    """POST /api/travel/upload-template — save the blank voucher PDF."""
    f = request.FILES.get("template")
    if not f:
        return JsonResponse({"error": "No file"}, status=400)
    if not f.name.lower().endswith(".pdf"):
        return JsonResponse({"error": "PDF required"}, status=400)
    with open(TEMPLATE_FILE, "wb") as fp:
        for chunk in f.chunks():
            fp.write(chunk)
    return JsonResponse({"ok": True})


def fill_pdf(template_path: Path, fields: dict, output_path: Path) -> None:
    """Fill AcroForm fields in the voucher template. Lazy-imports pypdf.

    Uses auto_regenerate=True so pypdf bakes /AP appearance streams into each
    widget annotation.  The values are then visible in all PDF viewers without
    depending on NeedAppearances support.
    """
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as exc:
        raise RuntimeError("pypdf is not installed — run: pip install pypdf") from exc

    reader = PdfReader(str(template_path))
    writer = PdfWriter(clone_from=reader)

    for page in writer.pages:
        writer.update_page_form_field_values(page, fields, auto_regenerate=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as fh:
        writer.write(fh)


def flatten_pdf(path: Path) -> None:
    """Flatten with Ghostscript. Raises RuntimeError if gs is unavailable."""
    import shutil as _shutil
    import subprocess as _subprocess
    tmp = path.with_suffix(".flat.pdf")
    cmd = [
        "gs", "-q", "-dBATCH", "-dNOPAUSE", "-dSAFER",
        "-sDEVICE=pdfwrite", "-dPreserveAnnots=false",
        f"-sOutputFile={tmp}", str(path),
    ]
    result = _subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript failed: {result.stderr}")
    _shutil.move(str(tmp), str(path))


@csrf_exempt
@require_POST
def tv_generate(request):
    """
    POST /api/travel/generate
    Body: { traveler: {...}, days: [{...}, ...] }
    Returns: { results: [{saved_filename, day_label, total, success, error}] }

    All days are merged into a single PDF (one page per day).  The file is
    saved to UPLOAD_DIR so the frontend can open the placement picker for
    optional signature / date stamping.
    """
    if not TEMPLATE_FILE.exists():
        return JsonResponse({"error": "Template PDF not uploaded yet."}, status=400)

    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    traveler = body.get("traveler") or {}
    days     = body.get("days") or []

    if not days:
        return JsonResponse({"error": "At least one day is required."}, status=400)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    try:
        fields, grand_total = _build_fields(traveler, days)
        filename = f"etravel_{ts}.pdf"
        fill_pdf(TEMPLATE_FILE, fields, UPLOAD_DIR / filename)

        dates = [d.get("trip_date", "") for d in days if d.get("trip_date")]
        label = f"{dates[0]} – {dates[-1]}" if len(dates) > 1 else (dates[0] if dates else "All Days")

        results = [{
            "saved_filename": filename,
            "day_label":      label,
            "total":          round(grand_total, 2),
            "success":        True,
            "error":          None,
        }]
    except Exception as e:
        results = [{
            "saved_filename": None,
            "day_label":      "All Days",
            "total":          0,
            "success":        False,
            "error":          str(e),
        }]

    return JsonResponse({"results": results})


@require_GET
def tv_download(request, filename):
    """GET /api/travel/download/<filename> — serve a filled (unsigned) voucher PDF.

    Files land in UPLOAD_DIR after tv_generate.  For signed copies use
    /api/autopen/download/<filename> instead.
    """
    try:
        path = _safe_path(UPLOAD_DIR, filename)
    except ValueError:
        raise Http404
    if not path.exists():
        raise Http404
    return FileResponse(
        open(path, "rb"),
        as_attachment=True,
        filename=filename,
        content_type="application/pdf",
    )
