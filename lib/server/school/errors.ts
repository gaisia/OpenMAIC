/** A refusal a school API turns into `{ error: { code, message } }`. */
export class SchoolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SchoolError';
  }
}

/** Raised by a repository when a live class already uses the name. */
export class SchoolNameTakenError extends Error {
  constructor() {
    super('a class with this name already exists');
    this.name = 'SchoolNameTakenError';
  }
}
