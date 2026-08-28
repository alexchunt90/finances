# Zero dependencies, so there is nothing to install — just the runtime,
# the server, and the static files.
FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

# State lives on a mounted volume, not in the image. It must be a directory:
# saves write a temp file and rename over the target, which fails against a
# bind-mounted single file.
ENV STATE_DIR=/state \
    HOST=0.0.0.0 \
    PORT=4174

EXPOSE 4174
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
