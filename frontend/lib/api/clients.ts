import { apiRequest } from "@/lib/api/client";
import type {
  Client,
  ClientCreatePayload,
  ClientRecruiter,
  ClientUpdatePayload,
  RecruiterUser,
} from "@/lib/api/types";

export async function listClients(limit = 200, offset = 0): Promise<Client[]> {
  return apiRequest<Client[]>(`/clients?limit=${limit}&offset=${offset}`);
}

export async function listAllClients(): Promise<Client[]> {
  const pageSize = 200;
  let offset = 0;
  const all: Client[] = [];
  while (true) {
    const batch = await listClients(pageSize, offset);
    all.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

export async function getClient(clientId: string): Promise<Client> {
  return apiRequest<Client>(`/clients/${clientId}`);
}

export async function createClient(payload: ClientCreatePayload): Promise<Client> {
  return apiRequest<Client>("/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateClient(
  clientId: string,
  payload: ClientUpdatePayload
): Promise<Client> {
  return apiRequest<Client>(`/clients/${clientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function softDeleteClient(clientId: string): Promise<void> {
  await apiRequest<void>(`/clients/${clientId}`, { method: "DELETE" });
}

// ── Recruiter assignment ──────────────────────────────────────────────────────

export async function listClientRecruiters(clientId: string): Promise<ClientRecruiter[]> {
  return apiRequest<ClientRecruiter[]>(`/clients/${clientId}/recruiters`);
}

export async function assignRecruiters(
  clientId: string,
  recruiterIds: string[]
): Promise<ClientRecruiter[]> {
  return apiRequest<ClientRecruiter[]>(`/clients/${clientId}/recruiters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recruiter_ids: recruiterIds }),
  });
}

export async function removeRecruiterFromClient(
  clientId: string,
  recruiterId: string
): Promise<void> {
  await apiRequest<void>(`/clients/${clientId}/recruiters/${recruiterId}`, {
    method: "DELETE",
  });
}

/**
 * Returns the list of all recruiter-role users in the org that can be assigned
 * to this client. Used to populate the assignment dropdown.
 * Requires clients:assign or clients:read.
 */
export async function listAvailableRecruiters(clientId: string): Promise<RecruiterUser[]> {
  return apiRequest<RecruiterUser[]>(`/clients/${clientId}/available-recruiters`);
}
