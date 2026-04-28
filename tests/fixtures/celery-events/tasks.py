from celery import Celery, shared_task
app = Celery("worker")

@app.task
def add(x, y):
    return x + y

@shared_task
def cleanup():
    return True

@app.task(bind=True, name="billing.report_usage_to_stripe", max_retries=3)
def report_usage_to_stripe_task(self):
    return None
