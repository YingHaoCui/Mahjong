FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOST=0.0.0.0 PORT=8080 ARENA_DATA_DIR=/data
WORKDIR /app
COPY . /app
RUN useradd --uid 10001 --create-home arena && mkdir -p /data && chown arena:arena /data
USER arena
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz',timeout=3)"
CMD ["python", "webgame/server.py"]
