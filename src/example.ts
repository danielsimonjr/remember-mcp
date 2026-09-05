#!/usr/bin/env bun
/**
 * Example usage of remember-mcp hybrid memory system (Bun).
 */
import { RememberSystem } from "./remember/index.ts";

async function main() {
  console.log("=".repeat(60));
  console.log("remember-mcp: Hybrid Memory System Demo");
  console.log("=".repeat(60));

  console.log("\n1. Initializing RememberSystem...");
  const remember = new RememberSystem({
    active_db: "demo.db",
    archive_dir: "demo_archives/",
    archive_threshold_days: 30,
    archive_min_salience: 0.3,
  });
  console.log("   ✓ Active memory (SQLite) initialized");
  console.log("   ✓ Archive directory created");

  console.log("\n2. Adding memories to active storage...");
  const memories = [
    {
      content: "The user prefers Python over JavaScript for backend development",
      tags: ["preference", "programming"],
    },
    {
      content: "Yesterday we discussed the new AI project roadmap in the team meeting",
      tags: ["work", "meeting"],
    },
    {
      content: "To deploy the app, run: docker build -t myapp . && docker push myapp",
      tags: ["devops", "deployment"],
    },
    {
      content: "I'm really excited about the progress we're making on this project!",
      tags: ["emotion", "project"],
    },
    {
      content: "The key insight is that simplicity beats complexity in system design",
      tags: ["wisdom", "design"],
    },
  ];

  for (const [i, mem] of memories.entries()) {
    const result = await remember.addMemory({
      content: mem.content,
      user_id: "demo_user",
      tags: mem.tags,
    });
    console.log(
      `   ${i + 1}. Added [${result.primary_sector}] ${mem.content.slice(0, 50)}...`,
    );
  }

  console.log("\n3. Querying active memories...");
  const queries = [
    "What are the user's programming preferences?",
    "Tell me about recent meetings",
    "How do I deploy the application?",
  ];

  for (const query of queries) {
    console.log(`\n   Query: '${query}'`);
    const results = await remember.query({
      query,
      user_id: "demo_user",
      k: 2,
      include_archive: false,
    });
    for (const [j, mem] of results.entries()) {
      console.log(`      ${j + 1}. [score: ${mem.score.toFixed(3)}, ${mem.location}]`);
      console.log(`         ${mem.content.slice(0, 60)}...`);
      console.log(
        `         Sector: ${mem.primary_sector}, Salience: ${mem.salience.toFixed(3)}`,
      );
    }
  }

  console.log("\n4. System Statistics...");
  const stats = await remember.getStats("demo_user");
  console.log(`   Active memories: ${stats.active_count}`);
  console.log(`   Archived memories: ${stats.archive_count}`);
  console.log(`   Total size: ${stats.total_size.toLocaleString()} bytes`);

  console.log("\n5. Cleanup...");
  remember.close();
  console.log("   ✓ System closed");
  console.log("\n" + "=".repeat(60));
  console.log("Demo complete!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
