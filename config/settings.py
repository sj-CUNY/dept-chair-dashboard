import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get(
    'DJANGO_SECRET_KEY',
    'dept-chair-dashboard-dev-key-change-before-production-use'
)

DEBUG = os.environ.get('DEBUG', 'False').lower() == 'true'

ALLOWED_HOSTS = ['*']

INSTALLED_APPS = [
    'django.contrib.staticfiles',
    'dashboard',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',  # serves static files with correct MIME types
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': False,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.template.context_processors.static',
            ],
            'loaders': [
                'django.template.loaders.filesystem.Loader',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

# No database needed
DATABASES = {}

# Static files — WhiteNoise serves these with correct Content-Type headers
STATIC_URL = '/static/'
STATICFILES_DIRS = [BASE_DIR / 'static']
STATIC_ROOT = BASE_DIR / 'staticfiles'
WHITENOISE_USE_FINDERS = True  # serve from STATICFILES_DIRS without collectstatic in dev

# File upload limit: 50 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 50 * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = 50 * 1024 * 1024

# App-level data directory
# DASHBOARD_DATA_DIR env var lets the desktop launcher redirect data to
# the user's app-data folder (e.g. ~/Library/Application Support/…)
DATA_DIR = Path(os.environ['DASHBOARD_DATA_DIR']) if 'DASHBOARD_DATA_DIR' in os.environ else BASE_DIR / 'data'
