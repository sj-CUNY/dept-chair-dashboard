from django.urls import path
from . import views, ehraf_gen_views, check_request_views, travel_voucher_views, form_filler_views

urlpatterns = [
    path('',                                    views.index,                  name='index'),
    path('api/status',                          views.api_status,             name='status'),

    # Reports
    path('api/reports',                         views.list_reports,           name='list_reports'),
    path('api/reports/download/<str:filename>', views.download_report,        name='download_report'),

    # eHRAF
    path('api/ehraf/run',                       views.run_ehraf,              name='run_ehraf'),

    # Schedule
    path('api/schedule/run',                    views.run_schedule,           name='run_schedule'),
    path('api/schedule/rooms',                  views.get_room_config,        name='get_room_config'),
    path('api/schedule/rooms/save',             views.save_room_config,       name='save_room_config'),

    # Autopen
    path('api/autopen/signature',                              views.autopen_signature,      name='autopen_signature'),
    path('api/autopen/sign',                                   views.sign_document,          name='sign_document'),
    path('api/autopen/upload-batch',                           views.upload_batch,               name='upload_batch'),
    path('api/autopen/sign-batch-with-form-type',              views.sign_batch_with_form_type,  name='sign_batch_with_form_type'),
    path('api/autopen/sign-multiple',                          views.sign_multiple,              name='sign_multiple'),
    path('api/autopen/sign-placement',                         views.sign_with_placement,    name='sign_with_placement'),
    path('api/autopen/preview/<str:filename>/<int:page_num>', views.preview_page,           name='autopen_preview'),
    path('api/autopen/documents',                              views.list_signed_documents,  name='list_signed_documents'),
    path('api/autopen/download/<str:filename>',                views.download_signed,        name='download_signed'),
    path('api/autopen/form-types',                             views.manage_form_types,      name='form_types'),
    path('api/autopen/form-types/<str:name>',                  views.delete_form_type_view,  name='delete_form_type'),
    path('api/autopen/signed/all',                             views.clear_signed_documents, name='clear_signed'),
    path('api/autopen/uploads/all',                            views.clear_upload_queue,     name='clear_uploads'),
    path('api/autopen/sign-with-form-type',                    views.sign_with_form_type,    name='sign_with_form_type'),
    path('api/autopen/detect-placements',                views.detect_placements,          name='detect_placements'),
    path('api/autopen/sign-batch-with-placements',        views.sign_batch_with_placements,  name='sign_batch_with_placements'),

    # Add-in file serving
    path('addin/<str:filename>',                views.serve_addin_file,       name='serve_addin'),

    # eHRAF payroll list generator
    path('api/ehraf/generate-payroll', ehraf_gen_views.generate_payroll, name='ehraf_generate'),

    # Check Request Form Filler
    path('api/check-request/vendors',                   check_request_views.list_cr_vendors,    name='cr_vendors'),
    path('api/check-request/vendors/save',              check_request_views.save_cr_vendor,     name='cr_vendor_save'),
    path('api/check-request/vendors/<str:label>',       check_request_views.delete_cr_vendor,   name='cr_vendor_delete'),
    path('api/check-request/template-status',           check_request_views.cr_template_status, name='cr_template_status'),
    path('api/check-request/upload-template',           check_request_views.cr_upload_template, name='cr_upload_template'),
    path('api/check-request/generate',                  check_request_views.cr_generate,        name='cr_generate'),
    path('api/check-request/sign',                      check_request_views.cr_sign_and_download, name='cr_sign'),

    # Travel Voucher Form Filler
    path('api/travel/profile',                    travel_voucher_views.get_profile,         name='tv_profile'),
    path('api/travel/profile/save',               travel_voucher_views.save_profile_view,   name='tv_profile_save'),
    path('api/travel/template-status',            travel_voucher_views.tv_template_status,  name='tv_template_status'),
    path('api/travel/upload-template',            travel_voucher_views.tv_upload_template,  name='tv_upload_template'),
    path('api/travel/generate',                   travel_voucher_views.tv_generate,         name='tv_generate'),
    path('api/travel/download/<str:filename>',    travel_voucher_views.tv_download,         name='tv_download'),

    # Generic Form Filler
    path('api/form-filler/upload',                                form_filler_views.ff_upload,   name='ff_upload'),
    path('api/form-filler/templates',                             form_filler_views.ff_list,     name='ff_list'),
    path('api/form-filler/templates/<str:name>',                  form_filler_views.ff_get,      name='ff_get'),
    path('api/form-filler/templates/<str:name>/update',           form_filler_views.ff_update,   name='ff_update'),
    path('api/form-filler/templates/<str:name>/delete',           form_filler_views.ff_delete,   name='ff_delete'),
    path('api/form-filler/templates/<str:name>/generate',         form_filler_views.ff_generate, name='ff_generate'),
]
