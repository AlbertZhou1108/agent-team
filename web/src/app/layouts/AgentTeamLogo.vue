<script setup lang="ts">
defineProps<{ collapsed?: boolean }>();
</script>

<template>
  <span
    class="agent-team-logo"
    :class="{ 'agent-team-logo-collapsed': collapsed }"
    role="img"
    aria-label="Agent Team"
  >
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path class="agent-team-links" d="M20 8.5 31 29H9Z" />
      <circle class="agent-team-node" cx="20" cy="8.5" r="3.4" />
      <circle class="agent-team-node" cx="31" cy="29" r="3.4" />
      <circle class="agent-team-node" cx="9" cy="29" r="3.4" />
      <circle class="agent-team-center" cx="20" cy="21.5" r="2.4" />
    </svg>
  </span>
</template>
