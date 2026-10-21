FROM node:20-slim

# Install FFmpeg, ffprobe, and Unicode / Tamil fonts for subtitle burn-in
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-noto-core \
    fonts-noto-ui-core \
    fonts-noto-extra \
    fonts-taml \
    fontconfig \
    ca-certificates \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --omit=dev

# Copy source files
COPY . .

# Default environment configuration
ENV PORT=8787
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV MAX_CONCURRENT_JOBS=1
ENV MAX_FILE_MB=250

EXPOSE 8787

CMD ["node", "server.js"]
