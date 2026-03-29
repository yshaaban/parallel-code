FROM node:24-trixie AS dev

RUN apt install -y git
RUN npm install -g npm@11.12.1 husky
RUN git config --global --add safe.directory /parallel


RUN echo "Setting up Codex CLI..."; \
    mkdir -p /var/run/sshd; \
    sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config; \
    CODEX_VERSION=$(curl -fsSL https://api.github.com/repos/openai/codex/releases/latest | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/') && \
    echo "Downloading OpenAI Codex CLI version: $CODEX_VERSION (GNU x86_64)" && \
    curl -fsSL "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/codex-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/codex.tar.gz && \
    tar -xzf /tmp/codex.tar.gz -C /tmp && \
    mv /tmp/codex-x86_64-unknown-linux-gnu /usr/local/bin/codex && \
    chmod +x /usr/local/bin/codex && \
    rm -f /tmp/codex.tar.gz;


RUN npm install -g @anthropic-ai/claude-code

#rename node user to parallel
RUN groupmod -n parallel node && \
    usermod -l parallel -d /home/parallel -m node
    
USER parallel