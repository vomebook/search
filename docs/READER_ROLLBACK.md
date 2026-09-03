# Reader Rollback

1. Select the last accepted release record and its exact GitHub and HF revisions.
2. Redeploy the affected project from that revision. Do not edit generated `_site` files or HF image output.
3. Run the project Reader live smoke and existing production smoke.
4. If the deployed pair has different Reader contract versions, roll back both projects.
5. Create a new release record containing the failed release, rollback target, reason, smoke results, operator, and UTC time. Never overwrite the failed record.
