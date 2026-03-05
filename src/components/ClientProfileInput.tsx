import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ClientProfile = {
  fullLegalName: string;
  currentAddress: string;
  employer: string;
};

type Props = {
  onProfileSubmit: (profile: ClientProfile) => void;
  isLocked: boolean;
};

export function ClientProfileInput({ onProfileSubmit, isLocked }: Props) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [employer, setEmployer] = useState("");

  const handleSubmit = () => {
    if (!name.trim() || !address.trim()) return;
    onProfileSubmit({
      fullLegalName: name.trim(),
      currentAddress: address.trim(),
      employer: employer.trim() || "None",
    });
  };

  if (isLocked) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            ✓ Client profile locked in for assessment
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          Client Profile — Required for Assessment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="client-name">Client Full Legal Name *</Label>
          <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <Label htmlFor="client-address">Current Address *</Label>
          <Input id="client-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>

        <div>
          <Label htmlFor="client-employer">
            Employer{" "}
            <span className="text-muted-foreground">(leave blank if none)</span>
          </Label>
          <Input id="client-employer" value={employer} onChange={(e) => setEmployer(e.target.value)} />
        </div>

        <Button onClick={handleSubmit} disabled={!name.trim() || !address.trim()}>
          Lock In Client Profile
        </Button>
      </CardContent>
    </Card>
  );
}
