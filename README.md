# Department Chair Dashboard

A self-contained Docker-based dashboard for departmental administrative workflows. Runs entirely locally — no external API keys required.

---

## Tools

### Autopen — PDF Signature Tool
Sign PDF documents with a saved or manually placed signature image.

- **Single document signing** — upload a PDF, drag the signature to position, sign and download
- **Batch / folder signing** — upload multiple PDFs at once; sign them one-by-one with the placement picker or use **Sign All** to apply the same placement to every file in one click
- **Form Types** — save a named signature placement (including optional Name and Date fields) for a recurring form; re-use it to skip manual placement on future uploads
  - Edit / rename a saved Form Type
  - Re-calibrate a Form Type against a new sample PDF
- **Auto-detect placements** — automatically locate signature fields from PDF form metadata
- **Name & Date fields** — optionally stamp the signer's printed name and the current date alongside the signature
- **Signed history** — browse and download all previously signed documents; Clear History button to reset
- **Upload queue** — manage queued PDFs before signing; Clear Queue button to reset

---

### Check Request Form Filler
Automatically fills a Check Request PDF template with vendor and payment details.

- Save and manage a list of **vendors** (payee name, address, tax ID, etc.) for quick re-use
- Upload a blank Check Request **template** once; it persists for all future requests
- Enter payment details (amount, account code, description, date) and generate a filled PDF
- **Sign** the filled form in one step using the Autopen signature

---

### Travel Voucher Form Filler
Fills a multi-day travel reimbursement PDF template.

- Save a **traveler profile** (name, title, department, employee ID, etc.) that pre-populates every voucher
- Upload a blank Travel Voucher **template** once
- Enter per-day travel expenses; the tool calculates totals and generates a filled PDF for each day
- Place **signature and date** on the generated voucher using the Autopen placement picker before downloading

---

### Course Schedule Analysis
Analyzes a PeopleSoft schedule export and produces a formatted Excel workbook.

Upload a schedule `.xlsx` export to generate a five-sheet report:

| Sheet | Contents |
|---|---|
| **Config** | Instructor name overrides, room re-assignments, and room capacity table. Edit and re-upload the same schedule to apply overrides. |
| **Capacity by Course** | Sections, corrected cap (room capacity), transfer reserve (8 seats for designated courses), effective cap, enrolled, available seats, fill rate, and Open / Filling / Full status |
| **Section Detail** | Every Active and Stop Enrl section with room cap, corrected cap, transfer reservation, enrolled, and available seats |
| **Room Availability Grid** | Standard academic time slots (rows) × tracked room × day (M / Tu / W / Th / F) columns. Cells show course / section / enrollment. FREE for open slots. Uses overlap matching so non-standard blocks (e.g. 10:50–13:30 Friday) correctly mark all covered standard rows. |
| **Free Slot Summary** | All unoccupied standard + evening + Friday extended blocks per tracked room |

- Color coding: red = 0 seats, yellow ≤ 5 seats, green > 5 seats available
- Transfer reserve courses: CSCI 373, 374, 375, 377 and MAT 301 (8 seats/section)
- Tracked rooms and capacities are editable in the **Config** sheet of the generated report
- **Manage Rooms UI** — click the "Manage Rooms" button on the Schedule Analysis page to add, remove, or adjust tracked rooms and their capacities directly in the browser. Changes are saved server-side and applied on every subsequent analysis run.

---

### eHRAF Quality Check
Validates an eHRAF Excel export for completeness and data quality.

- Checks for missing or malformed fields
- Produces a report with a summary, issue list, and statistics by document type and culture

---

### eHRAF Payroll List Generator
Generates a formatted payroll list from an eHRAF timesheet export.

---

## Quick Start

### Prerequisites
- Docker and Docker Compose

### Start

```bash
docker-compose up --build
```

Access the dashboard at **http://localhost:4552**

Run in background:
```bash
docker-compose up --build -d
```

### Stop

```bash
docker-compose down
```

### View logs

```bash
docker-compose logs -f
```

### Rebuild after code changes

```bash
docker-compose up --build
```

---

## Persistent Data

All data is stored in `./data/` on the host and mounted into the container — it survives restarts and rebuilds.

| Path | Contents |
|---|---|
| `data/uploads/` | Uploaded PDFs awaiting signing |
| `data/signed/` | Completed signed PDFs |
| `data/signatures/` | Saved signature image |
| `data/reports/` | Generated schedule and eHRAF reports |

---

## Configuration

### Room capacities (Schedule Analysis)
Two options:
1. **Manage Rooms UI** — click the "Manage Rooms" button on the Schedule Analysis page to add/remove/edit rooms and capacities. Changes persist in `data/room_config.json` and are applied automatically on every run.
2. **Config sheet** — edit the Room Capacities table in any generated schedule report, then re-upload the same schedule file. The dashboard preserves the Config sheet across refreshes.

### Instructor / room overrides (Schedule Analysis)
Add rows to the Instructor Overrides or Room Adjustments tables in the Config sheet, then re-upload.

### Django secret key
Set `DJANGO_SECRET_KEY` as an environment variable or in a `.env` file:
```
DJANGO_SECRET_KEY=your-secret-key-here
```

---

## Technical Stack

| Layer | Technology |
|---|---|
| Backend | Django 4.2 + Gunicorn |
| Frontend | Bootstrap 5, Vanilla JS |
| PDF processing | pypdf, PyMuPDF, ReportLab |
| Excel processing | openpyxl, pandas |
| Container | Docker + nginx (TLS on port 4553) |

---

## Troubleshooting

**Port already in use**
Change the host port in `docker-compose.yml`:
```yaml
ports:
  - "4552:4552"   # change the first number
```

**Container won't start / 403 error**
```bash
docker-compose logs
docker-compose down
docker-compose up --build
```

**Schedule workflow error after rebuild**
The container installs all dependencies from `requirements.txt` at build time. If a package is missing, rebuild:
```bash
docker-compose up --build
```

---

*Administrative Tool*
