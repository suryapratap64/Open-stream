
export class UserIdentityManager {
  private static readonly STORAGE_KEY = "mediasoup_userId";

  static getUserId(): string {

    let userId =
      typeof window !== "undefined"
        ? localStorage.getItem(this.STORAGE_KEY)
        : null;

    // If not found, create new one
    if (!userId) {
      userId = this.generateUserId();
      if (typeof window !== "undefined") {
        localStorage.setItem(this.STORAGE_KEY, userId);
      }
    }

    return userId;
  }

  /**
   * Generate unique user ID using crypto.randomUUID()
   */
  private static generateUserId(): string {
    return `user_${crypto.randomUUID()}`;
  }

  /**
   * Clear user ID (for logout/reset)
   */
  static clearUserId(): void {
    if (typeof window !== "undefined") {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  }

  /**
   * Check if user already has an identity
   */
  static hasUserId(): boolean {
    return typeof window !== "undefined"
      ? localStorage.getItem(this.STORAGE_KEY) !== null
      : false;
  }
}
