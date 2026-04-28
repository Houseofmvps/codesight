from celery import Celery
app = Celery("worker")

@app.task
def ping():
    return "pong"
