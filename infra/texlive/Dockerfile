FROM ghcr.io/xu-cheng/texlive-full@sha256:11383430b9a3e48c0b79339f34d8092f942f897d91ab3749d4899d06731fea7f

RUN addgroup -g 10001 -S latex && adduser -u 10001 -S -D -H -G latex latex
USER latex
WORKDIR /workspace
