FROM denoland/deno:2.3.3

WORKDIR /app

COPY deno.json ./
RUN deno install

COPY index.ts ./
# rw-mcp-identity: who a request acts for (a byte-identical copy of integrations/kubernetes-deployment/mcp-identity.ts)
COPY mcp-identity.ts ./

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
