const LOGICAL_ASSIGNMENTS = new Set(["&&=", "||=", "??="]);

// Match the classic listeners in ESLint 10.15.0. Follow ESLint's actual code
// paths rather than treating whole classes (including keys/heritage) as scopes.
export const programComplexityRule = {
  meta: { schema: [], messages: { score: "Program complexity: {{score}}." } },
  create(context) {
    const origins = [];
    let score = 1;
    const decision = () => {
      if (origins.at(-1) === "program") score++;
    };
    const optional = node => {
      if (node.optional === true) decision();
    };
    return {
      onCodePathStart(codePath) {
        origins.push(codePath.origin);
      },
      onCodePathEnd(codePath, node) {
        origins.pop();
        if (codePath.origin === "program") {
          context.report({ node, loc: { line: 1, column: 0 }, messageId: "score", data: { score } });
        }
      },
      CatchClause: decision,
      ConditionalExpression: decision,
      LogicalExpression: decision,
      ForStatement: decision,
      ForInStatement: decision,
      ForOfStatement: decision,
      IfStatement: decision,
      WhileStatement: decision,
      DoWhileStatement: decision,
      AssignmentPattern: decision,
      "SwitchCase[test]": decision,
      AssignmentExpression(node) {
        if (LOGICAL_ASSIGNMENTS.has(node.operator)) decision();
      },
      MemberExpression: optional,
      CallExpression: optional,
    };
  },
};
