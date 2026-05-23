const restrictedTypeAssertion = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow broad `as unknown` and `as Effect...` assertions in source code.",
    },
    messages: {
      restricted:
        "Avoid `as {{type}}` assertions. Model the type explicitly or fix the generic boundary.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const restrictedDomainTypes = new Set([
      "ArchitectureReviewFinding",
      "AiGatewayModelId",
      "ExportJobStatus",
      "RoomActivityEvent",
      "TraceState",
      "VoiceSuggestion",
    ]);

    return {
      TSAsExpression(node) {
        const typeText = sourceCode.getText(node.typeAnnotation).replace(/\s+/g, " ").trim();
        const baseTypeText = typeText
          .replace(/^ReadonlyArray<(.+)>$/, "$1")
          .replace(/^Array<(.+)>$/, "$1");

        if (
          typeText === "unknown" ||
          /^Effect(?:$|[.<])/.test(typeText) ||
          restrictedDomainTypes.has(baseTypeText)
        ) {
          context.report({
            node: node.typeAnnotation,
            messageId: "restricted",
            data: { type: typeText },
          });
        }
      },
    };
  },
};

export default {
  meta: {
    name: "effect-cf-local",
  },
  rules: {
    "no-unsafe-effect-casts": restrictedTypeAssertion,
  },
};
