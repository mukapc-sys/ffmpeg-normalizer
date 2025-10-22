FROM node:18-slim

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./
COPY VERSION ./

EXPOSE 3000

CMD ["npm", "start"]
