from celery import Celery
app = Celery("worker")

@app.task
def sync_users():
    return True
