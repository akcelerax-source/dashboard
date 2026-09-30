# NODEX ACE dashboard + backend as one always-on service.
# Stage 1 builds the dashboard; stage 2 runs FastAPI, which serves the built
# dashboard at "/" and the API/WebSocket at /api and /ws on the same origin.

FROM node:20-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/server.py backend/shared_state.json backend/
COPY --from=web /app/dist dist
ENV NODEX_PUBLIC=1 \
    PORT=8000
EXPOSE 8000
CMD ["python", "backend/server.py"]
