function toApiFeedback(feedback) {
  if (!feedback) return feedback;
  const { fid, fdescription, ...rest } = feedback;
  return { ...rest, id: fid, description: fdescription };
}

function toApiFeedbackPage(result) {
  return { ...result, items: (result.items || []).map(toApiFeedback) };
}

module.exports = { toApiFeedback, toApiFeedbackPage };
