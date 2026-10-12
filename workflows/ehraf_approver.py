import json
import shutil
import threading
import time
from datetime import date, datetime
from pathlib import Path

EHRAF_BASE = "https://doitapps2.jjay.cuny.edu/ehraf"
QUEUE_URL  = f"{EHRAF_BASE}/app_queues"

# 4-credit courses — must match ehraf_generator.FOUR_CREDIT_COURSES
_FOUR_CREDIT = {('MAT', '151'), ('MAT', '152'), ('MAT', '241')}

_state: dict = {
    'running':  False,
    'log':      [],
    'results':  [],
    'error':    None,
    'total':    0,
    'approved': 0,
}


def get_state() -> dict:
    return dict(_state)


def _log(msg: str) -> None:
    _state['log'].append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def _find_chrome() -> str | None:
    for p in [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ]:
        if Path(p).exists():
            return p
    return shutil.which('google-chrome') or shutil.which('chromium')


def _normalize_name(name: str) -> tuple:
    """Return (last_lower, first_lower) from 'Last, First' or 'First Last'."""
    name = name.strip()
    if ',' in name:
        parts = name.split(',', 1)
        last  = parts[0].strip().lower()
        first = parts[1].strip().lower().split()[0] if parts[1].strip() else ''
    else:
        parts = name.split()
        last  = parts[-1].lower() if parts else ''
        first = parts[0].lower()  if len(parts) >= 2 else ''
    return (last, first)


def _load_prev_instructor_set(data_dir: Path) -> set:
    """Load the previous full-semester payroll reference and return a set of
    normalised (last, first) name tuples so we can detect repeat instructors."""
    today = date.today()
    if today.month <= 7:           # Spring or Summer → previous full semester = Fall last year
        prev_season, prev_year = 'Fall', today.year - 1
    else:                          # Fall → previous = Spring this year
        prev_season, prev_year = 'Spring', today.year

    ref_path = data_dir / f'payroll_ref_{prev_season}{prev_year}.json'
    if not ref_path.exists():
        return set()
    try:
        data = json.loads(ref_path.read_text())
        return {_normalize_name(str(r.get('instructor', '')))
                for r in data.get('records', [])}
    except Exception:
        return set()


def _reject_form(page, comment: str) -> None:
    """Select cancel reason, add comment, click Reject, handle any confirmation."""
    try:
        page.locator("select#cancel_reason").select_option("other")
        time.sleep(0.2)
    except Exception:
        pass
    try:
        page.locator("textarea").first.fill(comment)
        time.sleep(0.2)
    except Exception:
        pass
    reject_btn = page.locator("a:has-text('Reject'), button:has-text('Reject')").first
    reject_btn.scroll_into_view_if_needed()
    reject_btn.click()
    # Handle SweetAlert2 confirmation if it appears
    try:
        page.wait_for_selector(".swal2-confirm", timeout=3_000)
        page.locator(".swal2-confirm").click()
    except Exception:
        pass
    try:
        page.wait_for_url("**/app_queues**", timeout=15_000)
    except Exception:
        pass


def _load_appt_type_ref(data_dir: Path) -> dict:
    """Load appointment types from latest payroll ref. Returns {normalized_name: 'New Hire'|'Repeat Appointment'}."""
    ref_path = data_dir / 'latest_payroll_ref.json'
    if not ref_path.exists():
        return {}
    try:
        data = json.loads(ref_path.read_text())
        result = {}
        for r in data.get('records', []):
            name = str(r.get('instructor', '')).strip()
            appt = str(r.get('appointment_type', '')).strip()
            if name and appt:
                result[_normalize_name(name)] = appt
        return result
    except Exception:
        return {}


def _load_payroll_ref(data_dir: Path) -> dict:
    """Load latest generator output as {(subject, catalog, section): record}."""
    ref_path = data_dir / 'latest_payroll_ref.json'
    if not ref_path.exists():
        return {}
    try:
        data = json.loads(ref_path.read_text())
        lookup = {}
        for r in data.get('records', []):
            key = (
                str(r.get('subject', '')).strip().upper(),
                str(r.get('catalog', '')).strip(),
                str(r.get('section', '')).strip(),
            )
            lookup[key] = r
        return lookup
    except Exception:
        return {}


def _date_cutoff() -> date:
    """Cutoff: 1 month before today. Forms with effective dates older than this are skipped."""
    today = date.today()
    month = today.month - 1 or 12
    year  = today.year if today.month > 1 else today.year - 1
    # Clamp day to last day of the resulting month
    import calendar
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(today.day, last_day))


def _parse_effective_date(date_str: str) -> date | None:
    """Parse 'MM/DD/YYYY' or 'MM/DD/YYYY\\n(Term:…)' into a date."""
    raw = date_str.split('\n')[0].split('(')[0].strip()
    for fmt in ('%m/%d/%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def _semester_weeks(page) -> int | None:
    """Return 15 for Fall/Spring, None for Summer/unknown (don't override)."""
    try:
        text = page.locator("select#semester option:checked").first.inner_text().strip().lower()
    except Exception:
        text = ""
    if "fall" in text or "spring" in text:
        return 15
    return None


def _correct_and_set_hours(page, payroll_ref: dict) -> None:
    """
    Read every course row from the form, compare against the generator reference,
    correct contact hours / professional hours, then set # Weeks via the modal.
    Logs every check and correction.
    """
    # ── 1. Read course rows from form ──────────────────────────────────────────
    courses = page.evaluate("""() => {
        const rows = [];
        let i = 0;
        while (document.getElementById('disc' + i) !== null) {
            rows.push({
                idx:      i,
                disc:     (document.getElementById('disc'      + i)?.value || '').trim().toUpperCase(),
                catalog:  (document.getElementById('courseid'  + i)?.value || '').trim(),
                section:  (document.getElementById('section'   + i)?.value || '').trim(),
                wkly_hrs: parseFloat(document.getElementById('wkly_hrs' + i)?.value) || 0,
            });
            i++;
        }
        return rows;
    }""")

    # ── 2. Determine expected values per course ────────────────────────────────
    corrections = []
    for c in courses:
        key = (c['disc'], c['catalog'], c['section'])
        ref = payroll_ref.get(key)
        if ref:
            expected_hrs = int(ref.get('credits', 3))
        else:
            # Fall back to built-in 4-credit set
            expected_hrs = 4 if key[:2] in _FOUR_CREDIT else 3

        if abs(c['wkly_hrs'] - expected_hrs) > 0.01:
            corrections.append({'idx': c['idx'], 'old': c['wkly_hrs'], 'new': expected_hrs})

    # ── 3. Correct per-course contact hours ────────────────────────────────────
    if corrections:
        for fix in corrections:
            page.evaluate(f"""() => {{
                const el = document.getElementById('wkly_hrs{fix['idx']}');
                if (el) {{
                    el.value = '{fix['new']}';
                    el.dispatchEvent(new Event('input',  {{bubbles: true}}));
                    el.dispatchEvent(new Event('change', {{bubbles: true}}));
                }}
            }}""")
            _log(f"  Corrected wkly_hrs{fix['idx']}: {fix['old']} → {fix['new']}")
        time.sleep(0.2)

        # Re-sum ttl_wkly_hrs and wk_hrs_ after per-course corrections
        updated = {fix['idx']: fix['new'] for fix in corrections}
        total_wkly = sum(
            updated.get(c['idx'], c['wkly_hrs']) for c in courses
        )
        page.evaluate(f"""() => {{
            ['ttl_wkly_hrs', 'wk_hrs_'].forEach(id => {{
                const el = document.getElementById(id);
                if (el) {{
                    el.value = '{total_wkly}';
                    el.dispatchEvent(new Event('input',  {{bubbles: true}}));
                    el.dispatchEvent(new Event('change', {{bubbles: true}}));
                }}
            }});
        }}""")
    else:
        total_wkly = sum(c['wkly_hrs'] for c in courses)

    # ── 4. Check / correct professional (PD) hours ────────────────────────────
    # Generator formula: PD hours = 15 (flat, regardless of course count/credits)
    expected_pd = 15
    try:
        current_pd_str = page.locator("#fc_pt_prof_hr").input_value()
        current_pd = float(current_pd_str) if current_pd_str else expected_pd
    except Exception:
        current_pd = expected_pd

    if abs(current_pd - expected_pd) > 0.01:
        page.locator("#fc_pt_prof_hr").click(click_count=3)
        page.locator("#fc_pt_prof_hr").type(str(expected_pd))
        page.locator("#fc_pt_prof_hr").dispatch_event('change')
        _log(f"  Corrected PD hours: {current_pd} → {expected_pd}")
        time.sleep(0.2)
    else:
        _log(f"  PD hours OK ({int(current_pd)})")
        # ── 5. Set # Weeks via the Calculate Total Hours modal ────────────────────
    weeks = _semester_weeks(page)
    if weeks is None:
        _log("  Semester is not Fall/Spring — skipping weeks adjustment")
        return

    try:
        edit_btn = page.locator("button, a", has_text="Edit Total Hours").first
        edit_btn.scroll_into_view_if_needed()
        edit_btn.click()
        page.wait_for_selector("#TOTAL_WEEKS", timeout=5_000)
    
        wk_input = page.locator("#TOTAL_WEEKS")
        wk_input.click(click_count=3)
        wk_input.type(str(weeks))
        page.evaluate("""() => {
            const el = document.getElementById('TOTAL_WEEKS');
            el.dispatchEvent(new Event('input',  {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
        }""")
        time.sleep(0.3)

        new_total = page.locator("#total_").input_value()
        _log(f"  Set weeks={weeks}, total hours → {new_total}")
    
        # 1. Clear text box focus to settle the Bootstrap state and prevent background scrolling
        page.evaluate("() => document.activeElement ? document.activeElement.blur() : null")
        time.sleep(0.2)

        # 2. Target the exact ID matching your modal's explicit Close anchor link
        try:
            # Using force=True tells Playwright to skip background actionability checks 
            # and immediately click the button exactly where it overlays on screen
            page.locator("#hrmodalclose").click(force=True, timeout=2000)
            _log("  Modal closed via explicit ID #hrmodalclose link.")
        except Exception as exc1:
            _log(f"  ID close failed ({exc1}), attempting top header close button...")
            
            try:
                # 3. Fallback: Target the explicit Bootstrap top-right "X" close header button
                page.locator("#hrsModal .modal-header button.close").click(force=True, timeout=1500)
                _log("  Modal closed via header close class button.")
            except Exception as exc2:
                _log(f"  Header button failed ({exc2}), running programmatic Javascript modal dismiss...")
                
                # 4. Ultimate Fallback: Directly toggle the Bootstrap hide method via the page context
                page.evaluate("$('#hrsModal').modal('hide');")
                
        time.sleep(0.3)
    except Exception as exc:
        _log(f"  ! Could not open Edit Total Hours modal: {exc}")


def _run(data_dir: Path, cdp_url: str | None) -> None:
    _state.update({'log': [], 'results': [], 'error': None, 'total': 0, 'approved': 0})

    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except ImportError:
        _state['error'] = (
            "playwright not installed — run: "
            "pip install playwright && playwright install chromium"
        )
        _state['running'] = False
        return

    payroll_ref = _load_payroll_ref(data_dir)
    if payroll_ref:
        _log(f"Loaded payroll reference ({len(payroll_ref)} course entries)")
    else:
        _log("No payroll reference found — will use built-in defaults (run generator first for best results)")

    appt_type_ref = _load_appt_type_ref(data_dir)
    if appt_type_ref:
        _log(f"Loaded appointment type reference ({len(appt_type_ref)} instructors) — appointment type check active")
    else:
        _log("No appointment type reference found — run the generator first to enable this check")

    try:
        with sync_playwright() as pw:

            # ── Connect to Chrome ──────────────────────────────────────────────
            if cdp_url:
                _log(f"Connecting to Chrome at {cdp_url}…")
                try:
                    browser = pw.chromium.connect_over_cdp(cdp_url)
                    context = browser.contexts[0]
                    page    = context.new_page()
                    owned   = False
                except Exception:
                    raise RuntimeError(
                        f"Could not connect to Chrome at {cdp_url}. "
                        f"Start Chrome with: open -na 'Google Chrome' --args "
                        f"--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug"
                    )
            else:
                # Running in Docker — try to reach Chrome on the host via CDP
                _log("No CDP URL provided — trying to auto-connect to Chrome on host…")
                for candidate in ('http://host.docker.internal:9222', 'http://localhost:9222'):
                    try:
                        browser  = pw.chromium.connect_over_cdp(candidate)
                        context  = browser.contexts[0]
                        page     = context.new_page()
                        owned    = False
                        _log(f"Connected to Chrome at {candidate} ✓")
                        break
                    except Exception:
                        continue
                else:
                    raise RuntimeError(
                        "Could not connect to Chrome on the host. "
                        "Quit Chrome, then open Terminal and run:\n\n"
                        "  open -na 'Google Chrome' --args "
                        "--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0\n\n"
                        "Log into eHRAF in that window, then click Run Approvals again."
                    )

            page.set_default_timeout(30_000)

            # ── Navigate to queue (handle login if needed) ─────────────────────
            _log("Navigating to eHRAF…")
            page.goto(QUEUE_URL)
            page.wait_for_load_state("networkidle")

            if "/index" in page.url or "login" in page.url.lower():
                _log("Not logged in — waiting up to 5 min for you to log in…")
                try:
                    page.wait_for_url(f"{EHRAF_BASE}/app_queues**", timeout=300_000)
                    page.wait_for_load_state("networkidle")
                    _log("Login detected ✓")
                except PWTimeout:
                    raise RuntimeError("Login timed out — please log in within 5 minutes.")

            # ── Collect pending forms ──────────────────────────────────────────
            _log("Loading approval queue…")
            try:
                page.get_by_label("Show entries").first.select_option("1000")
                page.wait_for_load_state("networkidle")
                time.sleep(1.5)
            except Exception:
                pass

            pending = []
            try:
                first_grid = page.get_by_role("grid").first
                rows = first_grid.get_by_role("row").all()[1:]
                for row in rows:
                    cells = row.get_by_role("gridcell").all()
                    if len(cells) < 7:
                        continue
                    ehraf_id = cells[0].inner_text().strip()
                    if not ehraf_id.isdigit():
                        continue
                    pending.append({
                        'id':     ehraf_id,
                        'name':   cells[1].inner_text().strip(),
                        'title':  cells[2].inner_text().strip(),
                        'date':   cells[3].inner_text().strip().split('\n')[0],
                        'action': cells[5].inner_text().strip(),
                    })
            except Exception as exc:
                raise RuntimeError(f"Could not read approval queue: {exc}")

            # ── Filter: skip anything with effective date > 1 month in the past ─
            cutoff = _date_cutoff()
            _log(f"Date filter: effective date ≥ {cutoff.strftime('%m/%d/%Y')}")
            approved_pending = []
            for item in pending:
                eff = _parse_effective_date(item.get('date', ''))
                if eff is None or eff >= cutoff:
                    approved_pending.append(item)
                else:
                    _log(f"  Skipping #{item['id']} {item['name']} — effective {item['date']} is too far in the past")
            pending = approved_pending

            _state['total'] = len(pending)
            if not pending:
                _log("No forms meet the date filter.")
                if owned:
                    context.close()
                _state['running'] = False
                return

            _log(f"Found {len(pending)} forms to approve (after date filter)")

            # ── Approve each form ──────────────────────────────────────────────
            results = []
            for i, item in enumerate(pending):
                _log(f"[{i+1}/{len(pending)}] #{item['id']} {item['name']} — {item['action']}")
                try:
                    page.goto(QUEUE_URL)
                    page.wait_for_load_state("networkidle")
                    time.sleep(0.8)

                    first_grid = page.get_by_role("grid").first
                    first_grid.get_by_role("link", name=item['id']).first.click()
                    page.wait_for_url("**/appl_details**", timeout=15_000)
                    page.wait_for_load_state("networkidle")

                    # ── Appointment type check ─────────────────────────────────
                    if appt_type_ref:
                        try:
                            fname = page.locator("#fname").input_value().strip()
                            lname = page.locator("#lname").input_value().strip()
                            key = _normalize_name(f"{lname}, {fname}")
                            expected_appt = appt_type_ref.get(key)
                            if expected_appt:
                                is_new_form = 'new' in item['action'].lower()
                                expected_new = (expected_appt == 'New Hire')
                                if is_new_form and not expected_new:
                                    _log(f"  ✗ Rejecting — {fname} {lname}: form is New Hire but generator says Repeat Appointment")
                                    try:
                                        _reject_form(page, "Instructor taught last semester — Repeat Appointment eHRAF required, not New Hire.")
                                        results.append({**item, 'success': False, 'error': 'Rejected: should be Repeat Appointment'})
                                    except Exception as exc_rej:
                                        _log(f"  ! Rejection failed: {exc_rej}")
                                        results.append({**item, 'success': False, 'error': f'Rejection failed: {exc_rej}'})
                                    continue
                                elif not is_new_form and expected_new:
                                    _log(f"  ✗ Rejecting — {fname} {lname}: form is Repeat Appointment but generator says New Hire")
                                    try:
                                        _reject_form(page, "Instructor is new this semester — New Hire eHRAF required, not Repeat Appointment.")
                                        results.append({**item, 'success': False, 'error': 'Rejected: should be New Hire'})
                                    except Exception as exc_rej:
                                        _log(f"  ! Rejection failed: {exc_rej}")
                                        results.append({**item, 'success': False, 'error': f'Rejection failed: {exc_rej}'})
                                    continue
                        except Exception as exc_sc:
                            _log(f"  ! Appointment type check error: {exc_sc}")

                    # ── Check & correct all fields ─────────────────────────────
                    try:
                        _correct_and_set_hours(page, payroll_ref)
                    except Exception as exc_corr:
                        _log(f"  ! Field correction error: {exc_corr}")

                    # ── Approve ────────────────────────────────────────────────
                    approve = page.locator("#submit_form, a:has-text('Approve'), button:has-text('Approve')").first
                    approve.scroll_into_view_if_needed()
                    time.sleep(0.4)
                    approve.click()

                    try:
                        page.wait_for_url("**/app_queues**", timeout=15_000)
                        results.append({**item, 'success': True})
                        _state['approved'] += 1
                        _log(f"  ✓ Approved")
                    except PWTimeout:
                        err_els = page.locator(".alert-danger, .text-danger").all()
                        err_msg = (
                            " | ".join(e.inner_text().strip() for e in err_els)
                            if err_els else "Did not return to queue after approval"
                        )
                        results.append({**item, 'success': False, 'error': err_msg})
                        _log(f"  ✗ {err_msg}")

                except Exception as exc:
                    results.append({**item, 'success': False, 'error': str(exc)})
                    _log(f"  ✗ Error: {exc}")

            _state['results'] = results
            failed = len([r for r in results if not r.get('success')])
            _log(f"Done — {_state['approved']} approved, {failed} failed")

            if owned:
                context.close()

    except Exception as exc:
        _state['error'] = str(exc)
        _log(f"Fatal: {exc}")
    finally:
        _state['running'] = False


def start(data_dir: Path, cdp_url: str | None = None) -> bool:
    """Start approval run in background thread. Returns False if already running."""
    if _state['running']:
        return False
    _state['running'] = True
    threading.Thread(target=_run, args=(data_dir, cdp_url), daemon=True).start()
    return True
