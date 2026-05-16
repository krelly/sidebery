# syntax=docker/dockerfile:1.7

FROM node:lts-bookworm-slim AS deps
WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .

RUN npm run build && npm run build.ext

FROM scratch AS export
COPY --from=build /src/dist/ /dist/
COPY --from=build /src/addon/ /addon/
