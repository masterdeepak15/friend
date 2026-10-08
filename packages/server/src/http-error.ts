/** An error whose status and message are safe to send to the client as they are. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
