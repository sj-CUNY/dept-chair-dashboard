"""
ehraf_gen_views.py — Generate eHRAF payroll spreadsheet from uploaded files.

POST /api/ehraf/generate-payroll
  Multipart form:
    schedule_file    — xlsx schedule export
    instructor_file  — xlsx instructor table (optional; uses cached copy if omitted)
    season           — Summer | Winter | Fall | Spring
    year             — e.g. 2026
    sessions         — JSON list of {code, start, end}

Returns xlsx file as attachment.
"""

import json
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from workflows.ehraf_generator import generate

DATA_DIR = settings.DATA_DIR
CACHED_INSTR_TABLE = DATA_DIR / 'instructor_table.xlsx'


@csrf_exempt
def generate_payroll(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    # ── Parse form fields ─────────────────────────────────────────────────────
    season = request.POST.get('season', '').strip()
    if season not in ('Summer', 'Winter', 'Fall', 'Spring'):
        return JsonResponse({'error': 'Invalid season'}, status=400)

    try:
        year = int(request.POST.get('year', 0))
    except ValueError:
        return JsonResponse({'error': 'Invalid year'}, status=400)

    try:
        sessions = json.loads(request.POST.get('sessions', '[]'))
    except (ValueError, TypeError):
        return JsonResponse({'error': 'Invalid sessions JSON'}, status=400)

    if not sessions:
        return JsonResponse({'error': 'At least one session is required'}, status=400)

    # ── Read uploaded files ───────────────────────────────────────────────────
    schedule_upload = request.FILES.get('schedule_file')
    if not schedule_upload:
        return JsonResponse({'error': 'schedule_file is required'}, status=400)
    schedule_bytes = schedule_upload.read()

    instr_upload = request.FILES.get('instructor_file')
    if instr_upload:
        instr_bytes = instr_upload.read()
        # Cache for future use
        CACHED_INSTR_TABLE.write_bytes(instr_bytes)
    elif CACHED_INSTR_TABLE.exists():
        instr_bytes = CACHED_INSTR_TABLE.read_bytes()
    else:
        return JsonResponse(
            {'error': 'instructor_file required (no cached copy found)'},
            status=400,
        )

    prev_upload = request.FILES.get('prev_schedule_file')
    prev_schedule_bytes = prev_upload.read() if prev_upload else None

    # ── Generate ──────────────────────────────────────────────────────────────
    try:
        xlsx_bytes, course_records = generate(
            schedule_bytes=schedule_bytes,
            instructor_bytes=instr_bytes,
            season=season,
            year=year,
            sessions=sessions,
            prev_schedule_bytes=prev_schedule_bytes,
        )
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)

    # Save structured reference for the approver to use
    import json as _json
    ref = {
        'season':  season,
        'year':    year,
        'records': course_records,
    }
    try:
        ref_text = _json.dumps(ref, default=str)
        (DATA_DIR / 'latest_payroll_ref.json').write_text(ref_text)
        (DATA_DIR / f'payroll_ref_{season}{year}.json').write_text(ref_text)
    except Exception:
        pass  # non-fatal

    filename = f'EHRAF_{season}{year}.xlsx'
    response = HttpResponse(
        xlsx_bytes,
        content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    return response
