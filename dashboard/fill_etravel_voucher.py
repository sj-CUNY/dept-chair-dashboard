"""
fill_etravel_voucher.py
=======================

Reconciles hiring-related expenses (breakfasts, lunches with job-talk
candidates, etc.) and produces a filled, flattened E-Travel Expense Voucher
PDF for each expense day.

Folder layout this expects (one folder per expense day):

    <root>/
        3-12-2026/
            <receipts, agendas, attendee lists, citibank dashboards, ...>
        3-16-2026/
            ...
        3-17-2026/
            ...
        E-travel-Voucher.pdf       <-- the blank fillable voucher template

Each day's filled voucher is written back into that day's folder as:
    E-travel-Voucher_FILLED_<folder>.pdf

How it works:
  1. Fills the AcroForm fields on the blank voucher (pypdf).
  2. Sets /NeedAppearances=True and strips stale /AP appearance streams so
     viewers regenerate text widgets from the new values.
  3. Flattens the result with Ghostscript so the filled values render
     identically in every PDF viewer (Adobe, Preview, Chrome, etc.).

Dependencies:
    pip install pypdf
    Ghostscript installed and on PATH (the `gs` command)

Usage:
    python fill_etravel_voucher.py /path/to/root_folder

Edit the EXPENSES dict below to add/change days, candidates, or amounts.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Tuple

from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, NameObject


# ---------------------------------------------------------------------------
# Configuration: traveler info and per-day expense breakdown
# ---------------------------------------------------------------------------

TRAVELER = {
    "Name": "",
    "Mailing Address 1": "",
    "Mailing Address 2": "",
    "City": "",
    "State": "",
    "Zip Code": "",
    "Yes": "/Yes",       # US Citizen / Permanent Resident
    "NO": "/Off",
    "$ of MIles": "",
    "Date4_af_date": "",   # signature date
}


@dataclass
class DayExpenses:
    """One expense day = one E-Travel Voucher."""
    folder: str
    candidate: str
    trip_date: str
    departure_city: str = ""
    destination_city: str = ""
    # Meals: list of (description, amount). Each entry goes in its own column.
    meals: List[Tuple[str, float]] = field(default_factory=list)
    transportation: List[Tuple[str, float]] = field(default_factory=list)
    lodging: List[Tuple[str, float]] = field(default_factory=list)
    local_travel: List[Tuple[str, float]] = field(default_factory=list)

    @property
    def total(self) -> float:
        return sum(amt for _, amt in (
            self.meals + self.transportation + self.lodging + self.local_travel
        ))


# Hiring expense ledger ().
# Amounts are taken from the credit-card dashboards (which include tip/tax),
# not from the receipt subtotals.
EXPENSES: List[DayExpenses] = [
    DayExpenses(
        folder="",
        candidate="",
        trip_date="",
        meals=[
            ("", 85.50),
            ("", 112.21),
        ],
    ),
    DayExpenses(
        folder="",
        candidate="",
        trip_date="",
        meals=[
            ("", 85.00),
            ("", 112.65),
        ],
    ),
    DayExpenses(
        folder="",
        candidate="",
        trip_date="",
        meals=[
            ("", 224.40),
        ],
    ),
]


# ---------------------------------------------------------------------------
# Form-field names in the E-Travel-Voucher.pdf template
# ---------------------------------------------------------------------------
# Itinerary and expense rows are indexed 0..6 (one column per date).
# We use column 0 for the date and per-category amounts.
# When a category has more than one entry on a single day we spill into
# columns .1, .2, ... so each receipt stays visible.

CATEGORY_PREFIX = {
    "meals":          "Meals",
    "transportation": "Transportation",
    "lodging":        "Lodging",
    "local_travel":   "Local Travel",
}
CATEGORY_TOTAL_FIELD = {
    "meals":          "Meals Total",
    "transportation": "Transportation Total",
    "lodging":        "Lodging Total",
    "local_travel":   "Local Travel Total",
}
ZERO_TOTAL_FIELDS = [
    "Transportation Total", "Lodging Total", "Local Travel Total",
    "Miles Total", "Other 1 Total", "Other 2 Total", "Other 3 Total",
]


# ---------------------------------------------------------------------------
# Core: build field dict, fill PDF, flatten with Ghostscript
# ---------------------------------------------------------------------------

def build_field_values(day: DayExpenses) -> Dict[str, str]:
    """Translate a DayExpenses into the AcroForm field-name -> value dict."""
    fields: Dict[str, str] = dict(TRAVELER)
    fields["Purpose of Trip 2"] = (
        f"Hiring expenses - Job Talk: {day.candidate} (candidate) "
        f"on {day.trip_date}"
    )

    # Itinerary - column 0 only (single-day "trip")
    fields["Date.0"] = day.trip_date
    fields["Depature City.0"] = day.departure_city  # (sic - typo in template)
    fields["Destination City.0"] = day.destination_city

    # Per-category line items - spill across columns .0, .1, .2, ...
    for cat, prefix in CATEGORY_PREFIX.items():
        entries = getattr(day, cat)
        for col, (_desc, amount) in enumerate(entries):
            fields[f"{prefix}.{col}"] = f"{amount:.2f}"
        total = sum(a for _, a in entries)
        fields[CATEGORY_TOTAL_FIELD[cat]] = f"{total:.2f}"

    # Zero out unused category totals so the form doesn't keep template "0"s
    for tf in ZERO_TOTAL_FIELDS:
        fields.setdefault(tf, "0.00")

    # Grand total (the template has two Total Expenses fields)
    fields["Total Expenses.0"] = f"{day.total:.2f}"
    fields["Total Expenses.1"] = f"{day.total:.2f}"
    return fields


def fill_pdf(template_path: Path, fields: Dict[str, str], output_path: Path) -> None:
    """Fill AcroForm fields and write the result to output_path."""
    reader = PdfReader(str(template_path))
    writer = PdfWriter(clone_from=reader)

    for page in writer.pages:
        writer.update_page_form_field_values(page, fields, auto_regenerate=False)

    # Strip stale text-widget appearance streams so viewers regenerate them
    # from the new /V values.
    for page in writer.pages:
        annots = page.get("/Annots")
        if not annots:
            continue
        annots = annots.get_object()
        for ann_ref in annots:
            ann = ann_ref.get_object()
            if ann.get("/Subtype") != "/Widget":
                continue
            if ann.get("/FT") == "/Tx" and "/AP" in ann:
                del ann[NameObject("/AP")]

    # Tell PDF viewers to regenerate widget appearances on open.
    root = writer._root_object
    if "/AcroForm" in root:
        acroform = root["/AcroForm"]
        if hasattr(acroform, "get_object"):
            acroform = acroform.get_object()
        acroform[NameObject("/NeedAppearances")] = BooleanObject(True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as fh:
        writer.write(fh)


def flatten_pdf(path: Path) -> None:
    """Bake form values into static page content using Ghostscript.

    This makes the filled values render correctly in every PDF viewer
    (including ones that don't honor /NeedAppearances).
    """
    tmp = path.with_suffix(".flat.pdf")
    cmd = [
        "gs", "-q", "-dBATCH", "-dNOPAUSE", "-dSAFER",
        "-sDEVICE=pdfwrite",
        "-dPreserveAnnots=false",
        f"-sOutputFile={tmp}",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript failed: {result.stderr}")
    shutil.move(str(tmp), str(path))


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def process(root: Path, template: Path) -> None:
    if not template.exists():
        sys.exit(f"Template not found: {template}")

    for day in EXPENSES:
        out = root / day.folder / f"E-travel-Voucher_FILLED_{day.folder}.pdf"
        fields = build_field_values(day)
        fill_pdf(template, fields, out)
        flatten_pdf(out)
        print(f"[OK] {day.folder}: {day.candidate:25s} total ${day.total:>7.2f} -> {out.name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root",
        type=Path,
        help="Folder containing per-day subfolders (e.g., 3-12-2026/) and "
             "the blank E-travel-Voucher.pdf template",
    )
    parser.add_argument(
        "--template",
        type=Path,
        default=None,
        help="Path to the blank E-travel-Voucher.pdf "
             "(default: <root>/E-travel-Voucher.pdf)",
    )
    args = parser.parse_args()
    template = args.template or (args.root / "E-travel-Voucher.pdf")
    process(args.root, template)


if __name__ == "__main__":
    main()
