/**
 * Ordinary in-app updates remain opt-in. A deliberate release-channel switch
 * from a loopback browser is allowed because the channel selector is itself the
 * local user's explicit request to change the checkout.
 */
export function isGitUpdateApplyAllowed(options: {
  updatesApplyEnabled: boolean;
  localChannelSwitchRequested: boolean;
}): boolean {
  return options.updatesApplyEnabled || options.localChannelSwitchRequested;
}

export type UpdateInstallType = "git" | "docker" | "standalone";
export type UpdateChannelId = "stable" | "staging";

export function isUpdateChannelSwitch(
  installType: UpdateInstallType,
  currentChannel: UpdateChannelId,
  selectedChannel: UpdateChannelId,
): boolean {
  return installType !== "standalone" && currentChannel !== selectedChannel;
}

export function resolveDockerChannelImageTags(image: string, latestVersion: string, channel: UpdateChannelId) {
  if (channel === "staging") {
    return {
      dockerImage: image,
      dockerImageTag: `${image}:staging`,
      dockerLiteImageTag: null,
    };
  }

  return {
    dockerImage: image,
    dockerImageTag: `${image}:${latestVersion}`,
    dockerLiteImageTag: `${image}:${latestVersion}-lite`,
  };
}
