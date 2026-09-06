FROM node:24.19.0-trixie AS dev

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git openssh-client && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g npm@11.17.0 husky @anthropic-ai/claude-code

RUN echo "Setting up Codex CLI..."; \
    CODEX_VERSION=$(curl -fsSL https://api.github.com/repos/openai/codex/releases/latest | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/') && \
    echo "Downloading OpenAI Codex CLI version: $CODEX_VERSION (GNU x86_64)" && \
    curl -fsSL "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/codex-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/codex.tar.gz && \
    tar -xzf /tmp/codex.tar.gz -C /tmp && \
    mv /tmp/codex-x86_64-unknown-linux-gnu /usr/local/bin/codex && \
    chmod +x /usr/local/bin/codex && \
    rm -f /tmp/codex.tar.gz;

RUN git config --system --add safe.directory /parallel

RUN groupmod -n parallel node && \
    usermod -l parallel -d /home/parallel -m node

WORKDIR /parallel

RUN chown parallel:parallel /parallel

COPY --chown=parallel:parallel package.json package-lock.json .npmrc ./
COPY --chown=parallel:parallel scripts/postinstall-native-fixups.mjs ./scripts/postinstall-native-fixups.mjs

ENV SSH_AUTH_SOCK=/ssh-agent

USER parallel

RUN git init /parallel && HUSKY=0 npm ci && rm -rf /parallel/.git
