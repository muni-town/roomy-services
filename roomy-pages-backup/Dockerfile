FROM node:alpine

# Uncomment if you are behind a proxy with a custom HTTPS certificate.
# COPY ./gitignore/ca-certificates.crt /etc/ssl/certs.pem
# ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs.pem

ENV CI=true

COPY . /project
WORKDIR /project

RUN apk add --no-cache git openssh-client-default
ENV GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"

RUN npm i -g pnpm
RUN pnpm i

ENTRYPOINT ["pnpm", "tsx", "main.ts"]