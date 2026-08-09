export type ProfessorMariTranscriptScrollContainer = {
  scrollHeight: number;
  scrollTop: number;
};

/** Align a mounted Professor Mari transcript with its newest message. */
export function scrollProfessorMariTranscriptToBottom(container: ProfessorMariTranscriptScrollContainer) {
  container.scrollTop = container.scrollHeight;
}
