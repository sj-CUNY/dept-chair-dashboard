"""
Desktop launcher entry point.
Starts the Django app via Waitress (cross-platform, pure-Python WSGI server).
Used by the Electron desktop wrapper instead of gunicorn.
"""
import os
import sys
from pathlib import Path

# Ensure the app directory is on the path regardless of working directory
APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

if __name__ == '__main__':
    import django
    from django.core.management import call_command

    django.setup()

    # Run collectstatic once if staticfiles/ doesn't exist yet
    static_root = APP_DIR / 'staticfiles'
    if not static_root.exists():
        print('[serve] Collecting static files…')
        call_command('collectstatic', '--noinput', verbosity=0)

    from waitress import serve
    from config.wsgi import application

    port = int(os.environ.get('DASHBOARD_PORT', 4552))
    print(f'[serve] Dashboard running at http://127.0.0.1:{port}', flush=True)
    serve(application, host='127.0.0.1', port=port, threads=4)
