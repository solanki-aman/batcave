# Batcave Alfred: Julia-1 decision model sidecar (CPU). Run next to the Batcave server.
FROM python:3.11-slim
WORKDIR /alfred
RUN pip install --no-cache-dir huggingface_hub \
 && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('SupersonicLabs/Julia-1', local_dir='/alfred/Julia-1')" \
 && (pip install --no-cache-dir -e /alfred/Julia-1 || pip install --no-cache-dir -r /alfred/Julia-1/requirements.txt || true)
COPY batcave_alfred.py .
EXPOSE 4778
CMD ["python", "batcave_alfred.py", "--model", "/alfred/Julia-1", "--host", "0.0.0.0", "--port", "4778"]
