import { ClusterProfile } from "../core/DomainTypes";
import { migrateClusterState } from "../config/Migrations";

export function migrateLegacyStateToProfiles(state: any, projectRoot = ""): { state: any; profiles: ClusterProfile[]; activeProfileId: string } {
  const migrated = migrateClusterState(state).state;
  const profile: ClusterProfile = {
    id: "default",
    name: "Default",
    projectRoot,
    servers: migrated.servers || [],
    artifactHub: migrated.artifactHub,
    settings: {
      agentEnabled: migrated.agentEnabled,
      agentStreamEnabled: migrated.agentStreamEnabled,
      allowOneShotForBackground: migrated.allowOneShotForBackground,
    },
  };
  return { state: { ...migrated, profiles: [profile], activeProfileId: profile.id }, profiles: [profile], activeProfileId: profile.id };
}
