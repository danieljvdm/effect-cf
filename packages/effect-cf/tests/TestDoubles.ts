/**
 * Completes a controlled partial implementation of a host interface.
 *
 * Keep this helper local to tests: production code must validate host values at
 * its boundary instead of relying on a partial implementation.
 */
type PartialTestDouble<Service> = {
  readonly [Key in keyof Service]?: Service[Key] extends CallableFunction
    ? Service[Key]
    : Service[Key] extends object
      ? PartialTestDouble<Service[Key]>
      : Service[Key];
};

export const makePartialTestDouble = <
  Service extends object,
  Implementation extends PartialTestDouble<Service> = PartialTestDouble<Service>,
>(
  implementation: Implementation,
): Service => {
  // SAFETY: Test fixtures deliberately implement only the host methods exercised by each test;
  // callers supply that controlled object and choose the host interface completed by the double.
  return implementation as Service & Implementation;
};
