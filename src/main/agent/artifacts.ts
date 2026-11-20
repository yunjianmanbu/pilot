/**
 * Session artifacts used to live here. The collector now sits in `shared` so the
 * renderer can group the same files by run for the answer-level change bar; this
 * module stays as the main-process entry point so existing imports keep working.
 */
export {
  artifactCandidate,
  artifactsFromCalls,
  collectArtifactsByRun,
  collectSessionArtifacts,
  type ArtifactCandidate,
} from '../../shared/artifacts'