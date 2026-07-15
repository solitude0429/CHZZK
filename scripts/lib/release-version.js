export const MAX_RELEASE_VERSION_COMPONENT_DIGITS = 9;

const COMPONENT_RE = new RegExp(`^(?:0|[1-9]\\d{0,${MAX_RELEASE_VERSION_COMPONENT_DIGITS - 1}})$`);

export function isCanonicalReleaseVersion(value) {
  return (
    typeof value === "string" &&
    value.split(".").length === 3 &&
    value.split(".").every((component) => COMPONENT_RE.test(component))
  );
}

export function assertCanonicalReleaseVersion(value, label = "Release version") {
  if (!isCanonicalReleaseVersion(value)) {
    throw new Error(
      `${label} must be canonical MAJOR.MINOR.PATCH with components of at most ${MAX_RELEASE_VERSION_COMPONENT_DIGITS} digits`,
    );
  }
  return value;
}
