FROM node:20-slim

# Install ffmpeg, python3, curl, ca-certificates (needed for video processing and yt-dlp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests and install
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Ensure work directory exists
RUN mkdir -p work

ENV NODE_ENV=production
ENV PORT=3000
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

EXPOSE 3000

CMD ["node", "server.js"]
