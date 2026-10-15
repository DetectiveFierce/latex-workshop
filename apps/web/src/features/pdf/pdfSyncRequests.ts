export class PdfSyncRequests {
  private active: { controller: AbortController; compilationId: string } | null = null;

  start(compilationId: string) {
    this.cancel();
    const request = { controller: new AbortController(), compilationId };
    this.active = request;
    return request;
  }

  isCurrent(
    request: { controller: AbortController; compilationId: string },
    compilationId: string | null,
  ) {
    return (
      this.active === request &&
      !request.controller.signal.aborted &&
      request.compilationId === compilationId
    );
  }

  cancel() {
    this.active?.controller.abort();
    this.active = null;
  }
}
