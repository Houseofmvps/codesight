from django.urls import path
urlpatterns = [
    path("api/users/", views.UserList.as_view()),
    path("api/users/<int:id>/", views.UserDetail.as_view()),
]