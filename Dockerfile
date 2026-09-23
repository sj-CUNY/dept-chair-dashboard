FROM python:3.11-slim

WORKDIR /app

# System deps: build tools + LibreOffice Writer for format-preserving DOCX→PDF conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libglib2.0-0 \
        libgl1 \
        libreoffice-writer \
        libreoffice-common \
        fonts-liberation \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code
COPY . .

# Persistent data directories (uploads, reports, signed docs, signatures)
RUN mkdir -p data/uploads data/reports data/signed data/signatures

# Collect static files into /app/staticfiles
RUN python manage.py collectstatic --noinput

EXPOSE 4552

# timeout raised to 180s to cover LibreOffice conversion of large documents
CMD ["gunicorn", \
     "--bind", "0.0.0.0:4552", \
     "--workers", "2", \
     "--timeout", "180", \
     "--access-logfile", "-", \
     "config.wsgi:application"]
