FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

COPY requirements.txt .
RUN pip install -r requirements.txt

# The large models are fetched at build time (hash checked) instead of being
# stored in git. The two small anti-spoofing models are in the repo.
COPY scripts/download_models.py scripts/download_models.py
RUN python scripts/download_models.py models
COPY models/antispoof_v2_2.7.onnx models/antispoof_v1se_4.0.onnx models/

COPY app app

RUN useradd --system --no-create-home face
USER face

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
