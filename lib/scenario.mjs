export const scenario = Object.freeze({
  id: 'synthetic-food-parcel-001',
  title: 'A food-parcel collection time change',
  notes: [
    'SYNTHETIC DEMO — no real caller or customer data.',
    'The caller asks to move a community food-parcel collection from Tuesday morning to Thursday afternoon.',
    'The agent explained that Thursday availability must be checked with the collection team.',
    'No change has been confirmed. No phone number, address or household details were provided.',
    'The agent has not contacted the collection team or sent a follow-up message.',
  ].join('\n'),
});

export function simulateDraft(notes) {
  const lines = notes.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const firstLine = lines.find(line => !/^synthetic demo/i.test(line)) || lines[0];
  return {
    draft: {
      enquiry: firstLine,
      relevantDetails: notes,
      uncertainties: 'This simulation does not interpret the notes or infer missing facts. Review the source and record any missing or uncertain information here.',
      nextSteps: 'Review the notes and edit all draft fields. Verify any proposed next steps before acting. This practice draft takes no action.',
    },
    provenance: {
      kind: 'simulation',
      label: 'SIMULATION — no model API call',
      generatedAt: new Date().toISOString(),
    },
  };
}
