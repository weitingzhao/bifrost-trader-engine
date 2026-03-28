"""Shim: use ``celery -A servers.celery_app`` or import ``backend.workers.celery_app`` directly."""

from backend.workers.celery_app import *  # noqa: F403, F401
