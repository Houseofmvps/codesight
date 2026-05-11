# Events & Queues

## bullmq

- `queue-name` [queue] — `src/detectors/events.ts`
- `job-name` [queue] — `src/detectors/events.ts`

## kafka

- `name` [topic] — `src/detectors/events.ts`

## redis-pub-sub

- `channel` [channel] — `src/detectors/events.ts`

## eventemitter

- `event-name` [event] — `src/detectors/events.ts`
- `) || content.includes(` [event] — `src/detectors/events.ts`

## celery

- `tests.fixtures.celery-detect.tasks.ping` [queue] → celery-task — `tests/fixtures/celery-detect/tasks.py`
- `tests.fixtures.celery-events.tasks.add` [queue] → celery-task — `tests/fixtures/celery-events/tasks.py`
- `tests.fixtures.celery-events.tasks.cleanup` [queue] → celery-task — `tests/fixtures/celery-events/tasks.py`
- `billing.report_usage_to_stripe` [queue] → celery-task — `tests/fixtures/celery-events/tasks.py`
- `tests.fixtures.python-celery-workspace.services.worker-service.tasks.sync_users` [queue] → celery-task — `tests/fixtures/python-celery-workspace/services/worker-service/tasks.py`

## scenegraph-observer

- `exitApp` [event] → node-field — `tests/fixtures/roku-apmc-style/components/MainScene.brs`
- `someField` [event] → node-field — `tests/fixtures/roku-channel/components/MainScene.brs`
