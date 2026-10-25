# swift · @negvol — stdlib-only image; hosted mode turns on because PORT is set
FROM python:3.12-slim
WORKDIR /app
COPY . .
ENV PYTHONUNBUFFERED=1 PORT=10000
EXPOSE 10000
CMD ["python", "start.py", "--no-browser"]
