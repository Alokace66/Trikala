# Trikala on Cloud Run — Node 22, no npm dependencies.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY public ./public
COPY server ./server
USER node
EXPOSE 8080
CMD ["node", "server/server.js"]
