FROM docker.io/cloudflare/sandbox:0.7.6-python
# Agent fleet worker: Claude Code CLI (node 20 is in the base image) + pytest for test oracles.
RUN npm install -g @anthropic-ai/claude-code@2.1.296 && python3 -m pip install --no-cache-dir pytest
# Claude Code refuses --dangerously-skip-permissions as root outside a declared sandbox.
ENV IS_SANDBOX=1
